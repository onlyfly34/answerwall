import { cleanup, fireEvent } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createFakeServices } from '../../contracts/testing.ts';
import { renderWithServices } from '../test-support.tsx';
import { COPIED_FEEDBACK_MS, Markdown } from './Markdown.tsx';
import { RENDER_INTERVAL_MS } from './scheduler.ts';

function setup(initialText = '') {
  const [text, setText] = createSignal(initialText);
  const [final, setFinal] = createSignal(false);
  const [visible, setVisible] = createSignal(true);
  const rendered = vi.fn();
  const services = renderWithServices(
    () => <Markdown text={text()} final={final()} visible={visible()} onRendered={rendered} />,
    createFakeServices(),
  );
  const container = document.querySelector<HTMLElement>('.wall-markdown');
  if (!container) throw new Error('the Markdown container was not rendered');
  return { container, rendered, services, setText, setFinal, setVisible };
}

describe('streamed Markdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('deltas within the throttle interval are rendered together, from the accumulated text', () => {
    const { container, rendered, setText } = setup('Hel');
    expect(container.textContent.trim()).toBe('Hel');
    const first = rendered.mock.calls.length;

    setText('Hello');
    setText('Hello **wor');
    setText('Hello **world**');
    expect(container.textContent.trim()).toBe('Hel');
    expect(rendered).toHaveBeenCalledTimes(first);

    vi.advanceTimersByTime(RENDER_INTERVAL_MS);
    expect(rendered).toHaveBeenCalledTimes(first + 1);
    expect(container.querySelector('strong')?.textContent).toBe('world');
    // The half-written emphasis of the middle delta never reached the document.
    expect(container.innerHTML).not.toContain('**');
  });

  test('the end of the answer renders the rest without waiting', () => {
    const { container, setText, setFinal } = setup('One');
    setText('One two');
    expect(container.textContent.trim()).toBe('One');
    setFinal(true);
    expect(container.textContent.trim()).toBe('One two');
  });

  test('a hidden cell does not render until it is shown again', () => {
    const { container, setText, setVisible, setFinal } = setup('Seen');
    setVisible(false);
    setText('Seen and more');
    setFinal(true);
    vi.advanceTimersByTime(5000);
    expect(container.textContent.trim()).toBe('Seen');
    setVisible(true);
    expect(container.textContent.trim()).toBe('Seen and more');
  });

  test('a hostile delta that completes a tag across updates never becomes an element', () => {
    const { container, setText } = setup('<img src="http://tracker.example/a.png" onerror="');
    setText('<img src="http://tracker.example/a.png" onerror="alert(1)">');
    vi.advanceTimersByTime(RENDER_INTERVAL_MS);
    setText(
      '<img src="http://tracker.example/a.png" onerror="alert(1)">\n\n<script>alert(2)</script>',
    );
    vi.advanceTimersByTime(RENDER_INTERVAL_MS);
    expect(container.querySelector('img, script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(2)</script>');
  });

  test('the copy button of a code block copies its code and confirms', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText }, userAgent: 'test' });
    const { container } = setup('```js\nlet a = 1;\n```');
    const button = container.querySelector('button');
    if (!button) throw new Error('the code block has no copy button');

    fireEvent.click(button);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith('let a = 1;\n');
    expect(button.textContent).toBe('Copied');
    vi.advanceTimersByTime(COPIED_FEEDBACK_MS);
    expect(button.textContent).toBe('Copy');
  });

  test('a failed copy says so', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: async () => Promise.reject(new Error('denied')) },
      userAgent: 'test',
    });
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    const { container } = setup('```\ncode\n```');
    const button = container.querySelector('button');
    if (!button) throw new Error('the code block has no copy button');
    fireEvent.click(button);
    await vi.advanceTimersByTimeAsync(0);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(button.textContent).toBe('Copy failed');
    expect(document.querySelector('textarea')).toBeNull();
  });

  test('the copy buttons follow a language change', () => {
    const { container, services } = setup('```\ncode\n```');
    services.i18n.setLanguage('zh-TW');
    expect(container.querySelector('button')?.textContent).toBe('複製');
    expect(container.querySelectorAll('.wall-code')).toHaveLength(1);
  });
});
