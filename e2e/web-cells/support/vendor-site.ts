/**
 * A stand-in for a vendor's chat web app, on loopback. It behaves like the
 * real ones in the ways that matter to a web cell: every page refuses to be
 * framed (`X-Frame-Options: DENY` and `frame-ancestors 'none'`), signing in
 * sets a `SameSite=Lax; HttpOnly` session cookie, and the chat page has an
 * input, a submit button that is enabled by input events, and an answer that
 * streams in and is marked when it has finished.
 *
 * It is reached as `http://vendor.localhost:<port>`: a loopback name that is
 * another site than `127.0.0.1` (the AnswerWall server) and than the
 * extension.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const VENDOR_HOST = 'vendor.localhost';
export const SESSION_COOKIE = 'vendor_session';
/** A `SameSite=None` cookie: the control that shows whether third-party cookies are blocked. */
export const PROBE_COOKIE = 'vendor_probe';
/** A `SameSite=Strict` cookie, as some sites use for the session itself. */
export const STRICT_COOKIE = 'vendor_strict';

export interface VendorRequest {
  method: string;
  path: string;
  /** Names of the cookies the browser sent. */
  cookies: string[];
  secFetchSite: string | undefined;
  secFetchDest: string | undefined;
  secFetchMode: string | undefined;
  origin: string | undefined;
  referer: string | undefined;
  userAgent: string | undefined;
}

export interface VendorSite {
  /** `http://vendor.localhost:<port>` */
  origin: string;
  port: number;
  requests: VendorRequest[];
  /** Prompts the chat endpoint accepted, oldest first. */
  prompts: string[];
  /** The answer the site streams for a prompt. */
  answerFor(prompt: string): string;
  close(): Promise<void>;
}

const REFUSE_FRAMING = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};

function cookieNames(request: IncomingMessage): string[] {
  return (request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim().split('=')[0] ?? '')
    .filter((name) => name !== '');
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const SIGNED_OUT = page(
  'Vendor: signed out',
  `<h1 data-testid="signed-out">Signed out</h1>
   <form method="post" action="/login"><button id="sign-in" type="submit">Sign in</button></form>`,
);

/**
 * The chat page. `?editor=rich` uses a contenteditable element in place of
 * the textarea, as most real chat apps do. The button stays disabled until an
 * `input` event has been seen, so a script that only assigns `.value` fails.
 */
const chatPage = (rich: boolean): string =>
  page(
    'Vendor: chat',
    `<h1 data-testid="chat">Chat</h1>
     <div id="answers"></div>
     ${
       rich
         ? '<div id="prompt" contenteditable="true" role="textbox" aria-label="Message"></div>'
         : '<textarea id="prompt" aria-label="Message"></textarea>'
     }
     <button id="send" type="button" disabled>Send</button>
     <script>
       const input = document.getElementById('prompt');
       const send = document.getElementById('send');
       const answers = document.getElementById('answers');
       const read = () => ('value' in input ? input.value : input.textContent);
       let seen = '';
       input.addEventListener('input', () => { seen = read(); send.disabled = seen.trim() === ''; });
       send.addEventListener('click', async () => {
         const prompt = seen;
         if ('value' in input) input.value = ''; else input.textContent = '';
         seen = '';
         send.disabled = true;
         const answer = document.createElement('div');
         answer.className = 'answer';
         answer.dataset.state = 'streaming';
         answers.append(answer);
         const response = await fetch('/api/chat', {
           method: 'POST',
           headers: { 'content-type': 'application/json' },
           body: JSON.stringify({ prompt }),
         });
         if (!response.ok) { answer.dataset.state = 'failed'; answer.textContent = 'HTTP ' + response.status; return; }
         const reader = response.body.getReader();
         const decoder = new TextDecoder();
         for (;;) {
           const { done, value } = await reader.read();
           if (done) break;
           answer.textContent += decoder.decode(value, { stream: true });
         }
         answer.dataset.state = 'done';
       });
     </script>`,
  );

/** A page that may be framed, and says which cookies came with its request. */
const framablePage = (names: string[]): string =>
  page('Vendor: framable', `<p data-testid="cookies">${names.join(',') || '(none)'}</p>`);

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function startVendorSite(): Promise<VendorSite> {
  const sessions = new Set<string>();
  const requests: VendorRequest[] = [];
  const prompts: string[] = [];
  const answerFor = (prompt: string): string => `Echo from the vendor: ${prompt} [end]`;

  const header = (request: IncomingMessage, name: string): string | undefined => {
    const value = request.headers[name];
    return Array.isArray(value) ? value.join(',') : value;
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://vendor.invalid');
    requests.push({
      method: request.method ?? 'GET',
      path: url.pathname,
      cookies: cookieNames(request),
      secFetchSite: header(request, 'sec-fetch-site'),
      secFetchDest: header(request, 'sec-fetch-dest'),
      secFetchMode: header(request, 'sec-fetch-mode'),
      origin: header(request, 'origin'),
      referer: header(request, 'referer'),
      userAgent: header(request, 'user-agent'),
    });
    const session = cookieValue(request, SESSION_COOKIE);
    const signedIn = session !== undefined && sessions.has(session);
    const html = (status: number, body: string): void => {
      response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        ...REFUSE_FRAMING,
      });
      response.end(body);
    };

    if (url.pathname === '/framable') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(framablePage(cookieNames(request)));
      return;
    }
    if (url.pathname === '/login' && request.method === 'POST') {
      const id = randomBytes(16).toString('hex');
      sessions.add(id);
      response.writeHead(303, {
        Location: '/',
        'Set-Cookie': [
          `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`,
          `${STRICT_COOKIE}=1; Path=/; HttpOnly; SameSite=Strict`,
          // `Secure` is accepted here because a `localhost` name is a trustworthy origin.
          `${PROBE_COOKIE}=1; Path=/; SameSite=None; Secure`,
        ],
        ...REFUSE_FRAMING,
      });
      response.end();
      return;
    }
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      if (!signedIn) {
        response.writeHead(401, { 'Content-Type': 'text/plain', ...REFUSE_FRAMING });
        response.end('signed out');
        return;
      }
      const { prompt } = JSON.parse(await readBody(request)) as { prompt: string };
      prompts.push(prompt);
      response.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        ...REFUSE_FRAMING,
      });
      for (const word of answerFor(prompt).split(/(?<= )/)) {
        response.write(word);
        await sleep(15);
      }
      response.end();
      return;
    }
    if (url.pathname === '/' && request.method === 'GET') {
      html(200, signedIn ? chatPage(url.searchParams.get('editor') === 'rich') : SIGNED_OUT);
      return;
    }
    html(404, page('Vendor: not found', '<p>Not found</p>'));
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://${VENDOR_HOST}:${port}`,
    port,
    requests,
    prompts,
    answerFor,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
