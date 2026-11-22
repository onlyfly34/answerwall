import { expect, test } from '../support/fixtures.ts';
import {
  peakRunning,
  phasesOf,
  readTimeline,
  recordTimeline,
  startResponsivenessProbe,
  stopResponsivenessProbe,
} from '../support/probes.ts';
import type { AskTarget } from '../support/server.ts';
import {
  answer,
  arrange,
  cancelAllButton,
  cell,
  cells,
  currentAskId,
  expectPhase,
  expectPhases,
  prompt,
  send,
  sendButton,
  showCell,
  statusOf,
} from '../support/wall.ts';

const MOCK_ANSWER = 'Hello from the mock CLI.';

/** How long the main thread may be busy in one piece, and between two frames, while answers stream. */
const MAX_LONG_TASK_MS = Number(process.env['E2E_MAX_LONG_TASK_MS'] ?? 500);
const MAX_FRAME_GAP_MS = Number(process.env['E2E_MAX_FRAME_GAP_MS'] ?? 1000);

/** A Markdown document in small pieces: headings, lists, a table and code blocks. */
function markdownPieces(sections: number): string[] {
  const pieces: string[] = [];
  for (let section = 1; section <= sections; section += 1) {
    pieces.push(
      `## Section ${section}\n\n`,
      `Some **bold** text, some *emphasis* and \`inline code\` in paragraph ${section}. `,
      'It continues for a while so that the paragraph wraps over several lines. ',
      'Here is [a link](https://example.com/page) that must not be fetched.\n\n',
      '- first item\n',
      '- second item\n',
      '- third item\n\n',
      '```ts\n',
      `const value${section} = ${section};\n`,
      `console.log(value${section});\n`,
      '```\n\n',
      '| a | b |\n|---|---|\n',
      `| ${section} | ${section * 2} |\n\n`,
    );
  }
  return pieces;
}

test.describe('asking', () => {
  test('an ask with 12 slots streams side by side with queueing visible', async ({
    wallPage: page,
    server,
    stub,
  }) => {
    const pieces = markdownPieces(8);
    stub.script('long', { chunks: pieces, delayMs: 10, holdAt: [40] });
    await server.setProviders(
      { claude: { concurrency: 2 }, codex: { concurrency: 1 }, grok: { concurrency: 2 } },
      [stub.instance({ concurrency: 3 })],
    );
    const slots: AskTarget[] = [
      ...['c1', 'c2', 'c3', 'c4'].map((slotId) => ({
        slotId,
        providerId: 'claude',
        model: 'mock-slow',
      })),
      ...['x1', 'x2'].map((slotId) => ({ slotId, providerId: 'codex', model: 'mock-slow' })),
      ...['g1', 'g2'].map((slotId) => ({ slotId, providerId: 'grok', model: 'mock-slow' })),
      ...['o1', 'o2', 'o3', 'o4'].map((slotId) => ({ slotId, providerId: 'stub' })),
    ];
    await recordTimeline(page);
    await arrange(page, server, slots);
    await expect(sendButton(page)).toHaveText('Send to 12');

    await send(page, 'Twelve cells at once');

    // The endpoint holds its three running streams half way, so this state
    // lasts until the test lets go: three answering, the fourth queued.
    await stub.held('long', 3);
    await expectPhases(page, { o1: 'streaming', o2: 'streaming', o3: 'streaming', o4: 'queued' });
    await expect(statusOf(page, 'o4')).toHaveText('Queued, position 1');
    await expect(statusOf(page, 'o1')).toHaveText('Answering');

    // While answers are coming in, a second ask cannot be sent.
    await prompt(page).fill('Not yet');
    await expect(sendButton(page)).toBeDisabled();
    await expect(page.locator('#wall-composer-hint')).toContainText('Answers are still coming in');
    await expect(cancelAllButton(page)).toBeVisible();

    // The CLI cells work through their queues on their own.
    for (const slotId of ['c1', 'c2', 'c3', 'c4', 'x1', 'x2', 'g1', 'g2']) {
      await expectPhase(page, slotId, 'done');
    }
    await expectPhases(page, { o1: 'streaming', o4: 'queued' });

    stub.release('long');
    for (const slot of slots) await expectPhase(page, slot.slotId, 'done');
    await expect(sendButton(page)).toBeEnabled();
    await expect(cancelAllButton(page)).toBeHidden();

    // What the page showed on the way, cell by cell.
    const timeline = await readTimeline(page);
    for (const slotId of ['c3', 'c4', 'x2', 'o4']) {
      const phases = phasesOf(timeline, slotId).filter((phase) => phase !== 'idle');
      expect(phases[0], `${slotId} starts queued`).toBe('queued');
      expect(phases.at(-1), `${slotId} ends done`).toBe('done');
      expect(phases.length, `${slotId} ran in between: ${phases.join(' > ')}`).toBeGreaterThan(2);
    }
    const statuses = (slotId: string): string[] =>
      timeline.filter((entry) => entry.slotId === slotId).map((entry) => entry.status);
    expect(statuses('c3')).toContain('Queued, position 1');
    expect(statuses('c4')).toContain('Queued, position 2');
    expect(statuses('x2')).toContain('Queued, position 1');
    // Codex answers in whole messages, and the cell said so while it ran.
    expect(statuses('x1').join('\n')).toContain('does not stream token by token');

    // No provider ever ran more cells than its concurrency allows…
    expect(peakRunning(timeline, ['c1', 'c2', 'c3', 'c4'])).toBe(2);
    expect(peakRunning(timeline, ['x1', 'x2'])).toBe(1);
    expect(peakRunning(timeline, ['g1', 'g2'])).toBeLessThanOrEqual(2);
    expect(peakRunning(timeline, ['o1', 'o2', 'o3', 'o4'])).toBe(3);
    // …and across providers the cells ran side by side.
    expect(
      peakRunning(
        timeline,
        slots.map((slot) => slot.slotId),
      ),
    ).toBeGreaterThanOrEqual(6);

    // Every answer is complete and the same as the server's record of it.
    const snapshot = await server.snapshot(await currentAskId(page));
    expect(snapshot.status).toBe('done');
    for (const slot of snapshot.slots) {
      expect(slot.status, slot.slotId).toBe('done');
      expect(slot.text, slot.slotId).toBe(
        slot.providerId === 'stub' ? pieces.join('') : MOCK_ANSWER,
      );
    }
  });

  test('12 cells streaming Markdown at the same time leave the page responsive', async ({
    wallPage: page,
    server,
    stub,
    device,
  }) => {
    const pieces = markdownPieces(24);
    stub.script('heavy', { chunks: pieces, delayMs: 12, holdAt: [6] });
    await server.setProviders({}, [stub.instance({ concurrency: 12 })]);
    const slots = Array.from({ length: 12 }, (_, index) => ({
      slotId: `o${index + 1}`,
      providerId: 'stub',
    }));
    await arrange(page, server, slots);
    await send(page, 'Stream a long document into every cell');

    // All twelve are running before the measurement starts.
    await stub.held('heavy', 12);
    for (const slot of slots) await expectPhase(page, slot.slotId, 'streaming');

    await startResponsivenessProbe(page);
    stub.release('heavy');

    // The page still reacts while the answers pour in.
    const typed = 'typing while twelve answers stream';
    const before = Date.now();
    await prompt(page).fill(typed);
    await expect(prompt(page)).toHaveValue(typed);
    if (device === 'phone') {
      await page.getByRole('tab').nth(5).click();
      await expect(cell(page, 'o6')).toBeVisible();
    } else {
      await cell(page, 'o2')
        .getByRole('button', { name: /^Maximise/ })
        .click();
      await expect(cell(page, 'o2')).toHaveClass(/wall-cell-maximised/);
      await cell(page, 'o2')
        .getByRole('button', { name: /^Restore/ })
        .click();
      await expect(cells(page).nth(11)).toBeVisible();
    }
    const interactionMs = Date.now() - before;

    for (const slot of slots) await expectPhase(page, slot.slotId, 'done');
    const measured = await stopResponsivenessProbe(page);
    test.info().annotations.push({
      type: 'responsiveness',
      description:
        `${measured.frames} frames in ${Math.round(measured.durationMs)} ms, ` +
        `longest frame gap ${Math.round(measured.maxFrameGap)} ms, ` +
        `${measured.longTasks.length} long tasks (longest ` +
        `${Math.round(Math.max(0, ...measured.longTasks))} ms), ` +
        `interactions took ${interactionMs} ms`,
    });

    // Frames kept coming for the whole time, and no single task froze the page.
    expect(measured.frames).toBeGreaterThan(measured.durationMs / 200);
    expect(Math.max(0, ...measured.longTasks)).toBeLessThan(MAX_LONG_TASK_MS);
    expect(measured.maxFrameGap).toBeLessThan(MAX_FRAME_GAP_MS);
    expect(interactionMs).toBeLessThan(5000);

    // Nothing was lost on the way: the visible answer has the last section.
    const shown = device === 'phone' ? 'o6' : 'o12';
    await showCell(page, device, shown);
    await expect(answer(page, shown).locator('h2')).toHaveCount(24);
    await expect(answer(page, shown).locator('table')).toHaveCount(24);
    const snapshot = await server.snapshot(await currentAskId(page));
    for (const slot of snapshot.slots) expect(slot.text, slot.slotId).toBe(pieces.join(''));
  });

  test('Ctrl+Enter sends, and each cell shows its answer, model, time and usage', async ({
    wallPage: page,
    server,
    device,
  }) => {
    await arrange(page, server, [
      { slotId: 'c1', providerId: 'claude', model: 'mock-reasoning' },
      { slotId: 'x1', providerId: 'codex' },
      { slotId: 'g1', providerId: 'grok', model: 'mock-echo' },
    ]);
    await prompt(page).fill('What is two plus two?');
    await prompt(page).press('Control+Enter');

    await expectPhases(page, { c1: 'done', x1: 'done', g1: 'done' });
    await expect(prompt(page)).toHaveValue('');
    await expect(page.locator('.wall-asked-text')).toHaveText('What is two plus two?', {
      useInnerText: false,
    });

    const claude = await showCell(page, device, 'c1');
    await expect(claude.locator('.wall-cell-status')).toHaveText('Done');
    await expect(claude.locator('.wall-markdown')).not.toBeEmpty();
    await expect(claude.getByTestId('elapsed')).toHaveText(/^\d+\.\d s$/);
    await expect(claude.getByTestId('usage')).toHaveText(/\d+ in · \d+ out/);
    await expect(claude.locator('.wall-cell-statusbar')).toContainText('mock-reasoning');
    await claude.locator('details.wall-reasoning summary').click();
    await expect(claude.locator('.wall-reasoning-text')).not.toBeEmpty();
    await expect(claude.getByRole('button', { name: 'Copy the answer of Claude' })).toBeVisible();

    const grok = await showCell(page, device, 'g1');
    await expect(grok.locator('.wall-markdown')).toHaveText('You said: What is two plus two?');
    const codex = await showCell(page, device, 'x1');
    await expect(codex.locator('.wall-markdown')).toHaveText(MOCK_ANSWER);

    // The prompt went to the CLIs on stdin or in a file, never as an argument.
    const runs = server.mockInvocations().filter((entry) => typeof entry.prompt === 'string');
    expect(runs.length).toBe(3);
    for (const run of runs) expect(run.argv?.join(' ')).not.toContain('two plus two');
  });

  test('cancelling one cell leaves the others running; cancel all stops the rest', async ({
    wallPage: page,
    server,
    device,
  }) => {
    await server.setProviders({ claude: { concurrency: 2 }, grok: { concurrency: 1 } });
    await arrange(page, server, [
      { slotId: 'c1', providerId: 'claude', model: 'mock-hang' },
      { slotId: 'c2', providerId: 'claude', model: 'mock-hang' },
      { slotId: 'c3', providerId: 'claude', model: 'mock-echo' },
      { slotId: 'g1', providerId: 'grok', model: 'mock-hang' },
      { slotId: 'g2', providerId: 'grok', model: 'mock-echo' },
    ]);
    await send(page, 'Cancel me');
    await expectPhases(page, {
      c1: 'waiting',
      c2: 'waiting',
      c3: 'queued',
      g1: 'waiting',
      g2: 'queued',
    });
    await expect(statusOf(page, 'c1')).toHaveText('Waiting for the first words');
    await expect(statusOf(page, 'c3')).toHaveText('Queued, position 1');

    // One cell: its place goes to the cell that was queued behind it.
    const first = await showCell(page, device, 'c1');
    await first.getByRole('button', { name: 'Cancel Claude' }).click();
    await expectPhase(page, 'c1', 'cancelled');
    await expect(statusOf(page, 'c1')).toHaveText('Cancelled');
    await expect(first.getByRole('button', { name: 'Cancel Claude' })).toBeHidden();
    await expectPhases(page, { c3: 'done', c2: 'waiting', g1: 'waiting', g2: 'queued' });
    await expect(sendButton(page)).toBeDisabled();

    // A queued cell can be cancelled before it ever starts.
    const queued = await showCell(page, device, 'g2');
    await queued.getByRole('button', { name: 'Cancel Grok' }).click();
    await expectPhases(page, { g2: 'cancelled', c2: 'waiting', g1: 'waiting' });

    // Everything that is left.
    await cancelAllButton(page).click();
    await expectPhases(page, {
      c1: 'cancelled',
      c2: 'cancelled',
      c3: 'done',
      g1: 'cancelled',
      g2: 'cancelled',
    });
    await expect(cancelAllButton(page)).toBeHidden();
    await prompt(page).fill('Again');
    await expect(sendButton(page)).toBeEnabled();

    // The cancelled CLIs are really gone, and the queued one never started.
    await expect.poll(() => server.liveMockPids()).toEqual([]);
    const snapshot = await server.snapshot(await currentAskId(page));
    expect(snapshot.status).toBe('done');
    expect(snapshot.slots.map((slot) => slot.status)).toEqual([
      'cancelled',
      'cancelled',
      'done',
      'cancelled',
      'cancelled',
    ]);
    const grokRuns = server
      .mockInvocations()
      .filter((entry) => entry.kind === 'grok' && entry.scenario);
    expect(grokRuns.map((entry) => entry.scenario)).toEqual(['hang']);
  });

  test('a provider that answers in whole messages says so while it generates', async ({
    wallPage: page,
    server,
    device,
  }) => {
    await arrange(page, server, [
      { slotId: 'x1', providerId: 'codex', model: 'mock-hang' },
      { slotId: 'c1', providerId: 'claude', model: 'mock-hang' },
    ]);
    await send(page, 'Block streaming');
    await expectPhases(page, { x1: 'waiting', c1: 'waiting' });
    await expect(statusOf(page, 'x1')).toHaveText(
      'Generating — this provider does not stream token by token',
    );
    await expect(statusOf(page, 'c1')).toHaveText('Waiting for the first words');

    await cancelAllButton(page).click();
    await expectPhases(page, { x1: 'cancelled', c1: 'cancelled' });

    // A whole message arrives in one piece and the cell ends like any other.
    await arrange(
      page,
      server,
      [{ slotId: 'x2', providerId: 'codex', model: 'mock-block' }],
      'Block',
    );
    await send(page, 'Block streaming again');
    await expectPhase(page, 'x2', 'done');
    await showCell(page, device, 'x2');
    await expect(answer(page, 'x2')).toHaveText(MOCK_ANSWER);
  });

  test('each failure is explained in its cell', async ({ wallPage: page, server, device }) => {
    test.slow();
    await server.setLimits({ slotTimeoutMs: 5000 });
    await server.setProviders({
      claude: { concurrency: 5 },
      codex: { concurrency: 5 },
      grok: { concurrency: 5 },
    });
    await arrange(page, server, [
      { slotId: 'loggedout', providerId: 'claude', model: 'mock-logged-out' },
      { slotId: 'quota', providerId: 'claude', model: 'mock-quota' },
      { slotId: 'ratelimited', providerId: 'codex', model: 'mock-rate-limited' },
      { slotId: 'nomodel', providerId: 'grok', model: 'mock-model-not-found' },
      { slotId: 'crashed', providerId: 'codex', model: 'mock-exit-nonzero' },
      { slotId: 'garbage', providerId: 'claude', model: 'mock-garbage' },
      { slotId: 'timeout', providerId: 'grok', model: 'mock-hang' },
      { slotId: 'fine', providerId: 'grok' },
    ]);
    await send(page, 'Fail in every way');

    const failures: Record<string, string> = {
      loggedout: 'The provider is not logged in.',
      quota: 'The quota of this provider is used up.',
      ratelimited: 'The provider is rate limiting requests. Try again later.',
      nomodel: 'The provider does not know this model.',
      crashed: 'The provider failed.',
    };
    for (const [slotId, message] of Object.entries(failures)) {
      await expectPhase(page, slotId, 'error');
      const shown = await showCell(page, device, slotId);
      await expect(shown.locator('.wall-cell-status')).toHaveText('Failed');
      await expect(shown.getByRole('alert').locator('strong')).toHaveText(message);
    }
    // A diagnostic of the CLI never brings a path of the server's file system to the page.
    await expect(cell(page, 'crashed').getByRole('alert')).not.toContainText('secret-dir');

    // Output that is not in the documented format is shown as it is, not dropped.
    await expectPhase(page, 'garbage', 'done');
    await showCell(page, device, 'garbage');
    await expect(answer(page, 'garbage')).toContainText(
      'This is not the documented output format.',
    );
    await expect(answer(page, 'garbage')).toContainText('Second line of plain text.');

    // The cell that never answers is stopped by the time limit, and says so.
    await expect(cell(page, 'timeout')).toHaveAttribute('data-phase', 'timeout', {
      timeout: 20_000,
    });
    await showCell(page, device, 'timeout');
    await expect(statusOf(page, 'timeout')).toHaveText('Timed out');

    // One failing cell does not take the others with it.
    await expectPhase(page, 'fine', 'done');
    await expect(sendButton(page)).toBeDisabled();
    await prompt(page).fill('Next');
    await expect(sendButton(page)).toBeEnabled();
    await expect.poll(() => server.liveMockPids()).toEqual([]);
  });

  test('answers and code blocks are copied to the clipboard', async ({
    wallPage: page,
    context,
    server,
    stub,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const code = 'const answer = 42;\nconsole.log(answer);';
    const text = `Here is the code:\n\n\`\`\`ts\n${code}\n\`\`\`\n\nThat is all.`;
    stub.script('code', { chunks: [text] });
    await server.setProviders({}, [stub.instance()]);
    await arrange(page, server, [{ slotId: 'o1', providerId: 'stub' }]);
    await send(page, 'Show me code');
    await expectPhase(page, 'o1', 'done');
    // Text put on the Windows clipboard gets the line ends of Windows; it is the same text.
    const clipboard = async (): Promise<string> =>
      (await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n');

    const block = answer(page, 'o1').locator('.wall-code');
    await expect(block.locator('.wall-code-header span')).toHaveText('ts');
    await block.getByRole('button', { name: 'Copy' }).click();
    await expect(block.getByRole('button')).toHaveText('Copied');
    expect((await clipboard()).trim()).toBe(code);
    // The confirmation goes away by itself.
    await expect(block.getByRole('button')).toHaveText('Copy');

    await cell(page, 'o1')
      .getByRole('button', { name: 'Copy the answer of Stub endpoint' })
      .click();
    await expect(cell(page, 'o1').locator('.wall-cell-footer button')).toHaveText('Copied');
    // The whole answer, as the Markdown it was written in.
    expect(await clipboard()).toBe(text);
  });

  test('an answer beyond the size limit is cut and flagged; a prompt beyond its limit is not sent', async ({
    wallPage: page,
    server,
    stub,
    device,
  }) => {
    const line = `${'lorem ipsum dolor sit amet '.repeat(36)}\n\n`;
    stub.script('big', { chunks: Array.from({ length: 40 }, () => line) });
    await server.setLimits({ maxOutputBytesPerSlot: 16 * 1024, maxPromptBytes: 1024 });
    await server.setProviders({}, [stub.instance()]);
    await arrange(page, server, [
      { slotId: 'o1', providerId: 'stub' },
      { slotId: 'c1', providerId: 'claude', model: 'mock-tool-denied' },
    ]);

    // The composer counts the prompt in bytes and refuses one that is too long.
    await prompt(page).fill('é'.repeat(600));
    await expect(sendButton(page)).toBeDisabled();
    await expect(page.locator('#wall-composer-hint')).toContainText('The prompt is too long.');
    await expect(page.locator('.wall-composer-size')).toHaveText('1.2 KB of 1.0 KB');
    await expect(prompt(page)).toHaveAttribute('aria-invalid', 'true');
    await prompt(page).press('Control+Enter');
    await expect(page.locator('.wall-asked')).toHaveCount(0);

    await send(page, 'A long answer please');
    await expectPhases(page, { o1: 'done', c1: 'done' });
    await showCell(page, device, 'o1');
    await expect(cell(page, 'o1').locator('.wall-cell-flag')).toHaveText(
      'Truncated: the answer reached the output size limit.',
    );
    const snapshot = await server.snapshot(await currentAskId(page));
    const kept = Buffer.byteLength(snapshot.slots[0]?.text ?? '');
    expect(kept).toBeGreaterThan(8 * 1024);
    expect(kept).toBeLessThanOrEqual(16 * 1024);

    // A tool call the CLI denied is mentioned in the cell, above the answer.
    await showCell(page, device, 'c1');
    await expect(cell(page, 'c1').locator('.wall-cell-notice')).not.toBeEmpty();
    await expect(answer(page, 'c1')).not.toBeEmpty();
  });

  test('cells are added, duplicated, reconfigured and removed on the wall', async ({
    wallPage: page,
    server,
    device,
  }) => {
    // A fresh wall has one cell per enabled provider.
    await expect(cells(page)).toHaveCount(3);
    await expect(sendButton(page)).toHaveText('Send to 3');
    const labels = (): Promise<string[]> => page.locator('.wall-cell-name').allTextContents();
    expect(await labels()).toEqual(['Claude', 'Codex', 'Grok']);

    await page.getByRole('button', { name: 'Add cell' }).click();
    await expect(cells(page)).toHaveCount(4);
    expect(await labels()).toEqual(['Claude', 'Codex', 'Grok', 'Grok']);

    // The new cell becomes a Claude cell with a model of its own.
    const added = cells(page).nth(3);
    if (device === 'phone') await page.getByRole('tab').nth(3).click();
    await added.getByLabel('Provider').selectOption('claude');
    await added.getByLabel('Model').selectOption('haiku');
    await expect(added.locator('.wall-cell-model')).toHaveText('haiku');

    if (device === 'phone') await page.getByRole('tab').nth(0).click();
    await cells(page).nth(0).getByRole('button', { name: 'Duplicate Claude' }).click();
    await expect(cells(page)).toHaveCount(5);
    expect(await labels()).toEqual(['Claude', 'Claude', 'Codex', 'Grok', 'Claude']);

    if (device === 'phone') await page.getByRole('tab').nth(2).click();
    await cells(page).nth(2).getByRole('button', { name: 'Remove Codex' }).click();
    await expect(cells(page)).toHaveCount(4);
    await expect(sendButton(page)).toHaveText('Send to 4');

    // The arrangement survives a reload of the page.
    await page.reload();
    await expect(cells(page)).toHaveCount(4);
    expect(await labels()).toEqual(['Claude', 'Claude', 'Grok', 'Claude']);

    await send(page, 'Who answers?');
    await expect(cells(page).and(page.locator('[data-phase="done"]'))).toHaveCount(4);
    const models = server
      .mockInvocations()
      .filter((entry) => typeof entry.prompt === 'string' && entry.kind === 'claude')
      .map((entry) => entry.argv?.[(entry.argv.indexOf('--model') ?? -1) + 1]);
    expect(models.filter((model) => model === 'haiku')).toHaveLength(1);

    // With every cell removed there is nothing to send to.
    for (let remaining = 4; remaining > 0; remaining -= 1) {
      await cells(page).first().locator('button[aria-label^="Remove"]').click();
      await expect(cells(page)).toHaveCount(remaining - 1);
    }
    await expect(page.locator('.wall-empty')).toContainText('The wall has no cells');
    await expect(sendButton(page)).toBeDisabled();
  });
});

test.describe('with every CLI logged out', () => {
  test.use({
    serverOptions: { mocks: 'all', mockDelayMs: 120, env: { MOCK_CLI_SCENARIO: 'logged-out' } },
  });

  test('cells warn before sending and report the failure after', async ({
    wallPage: page,
    device,
  }) => {
    const first = cells(page).first();
    await expect(first.locator('.wall-cell-issue')).toContainText(
      'This provider is not logged in.',
    );
    await expect(first.locator('.wall-cell-issue').getByRole('link')).toHaveText('Open Providers');

    // The warning comes from a cached check; sending is still allowed and the CLI has the last word.
    await send(page, 'Anyone there?');
    await expect(cells(page).and(page.locator('[data-phase="error"]'))).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) {
      if (device === 'phone') await page.getByRole('tab').nth(index).click();
      await expect(cells(page).nth(index).getByRole('alert').locator('strong')).toHaveText(
        'The provider is not logged in.',
      );
    }

    if (device === 'phone') await page.getByRole('tab').nth(0).click();
    await first.locator('.wall-cell-issue').getByRole('link').click();
    await expect(page).toHaveURL(/\/providers$/);
  });
});
