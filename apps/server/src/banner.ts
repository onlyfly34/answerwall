import { BRAND } from '@answerwall/core';
import type { AppConfig } from '@answerwall/core';
import { bindsLoopback, bindsWildcard } from './config.ts';

export interface StartupLine {
  level: 'info' | 'warn';
  message: string;
  fields?: Record<string, unknown>;
}

const env = (name: string): string => `${BRAND.envPrefix}${name}`;

/**
 * What the operator is told once the socket is bound: where to open the UI,
 * and everything about the configuration that weakens security or will keep
 * a browser out. Never contains a token.
 */
export function startupLines(
  config: AppConfig,
  listening: { port: number; url: string },
): StartupLine[] {
  const scheme = config.tls.mode === 'off' ? 'http' : 'https';
  const local =
    bindsLoopback(config) || bindsWildcard(config)
      ? `${scheme}://localhost:${listening.port}`
      : listening.url;
  const lines: StartupLine[] = [
    {
      level: 'info',
      message: `${BRAND.name} ${config.version} is listening`,
      fields: {
        url: local,
        ...(config.publicOrigins.length > 0 ? { publicOrigins: config.publicOrigins } : {}),
        tls: config.tls.mode,
      },
    },
  ];
  const warn = (message: string) => lines.push({ level: 'warn', message });
  const exposed = !bindsLoopback(config);

  if (config.tls.mode === 'off' && exposed) {
    if (config.allowInsecure) {
      warn(
        `INSECURE MODE: plain HTTP is accepted from other machines (${env('ALLOW_INSECURE')}). ` +
          'Anyone on the network path can read what is sent, including the session cookie.',
      );
    } else if (config.trustedProxies.length === 0) {
      warn(
        'Plain HTTP on a non-loopback address: connections from other machines are refused. ' +
          `Put a TLS-terminating proxy in front and list it in ${env('TRUSTED_PROXIES')}, or set ${env('TLS')}.`,
      );
    }
  }
  if (config.tls.mode === 'off' && config.allowInsecure && !exposed) {
    warn(`${env('ALLOW_INSECURE')} has no effect while the server is bound to loopback.`);
  }
  if (exposed && config.publicOrigins.length === 0) {
    warn(
      `No public origin is configured, so browsers are accepted only under a loopback name. Set ${env('PUBLIC_ORIGINS')}.`,
    );
  }
  if (config.trustedProxies.length > 0 && config.tls.mode !== 'off') {
    warn(
      `${env('TRUSTED_PROXIES')} is set while TLS is on: forwarded headers are still honoured from those addresses.`,
    );
  }
  if (config.webRoot === undefined) {
    warn('The web UI has not been built: only the API is served.');
  }
  if (config.staticToken !== undefined) {
    lines.push({
      level: 'info',
      message: `A static token is configured (${env('TOKEN')}); it signs in without pairing.`,
    });
  }
  return lines;
}
