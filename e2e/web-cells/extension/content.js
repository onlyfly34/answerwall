// Runs in every frame of the stand-in vendor site, and does nothing unless
// the frame sits directly under this extension's own wall page.
(() => {
  const ancestors = globalThis.location.ancestorOrigins;
  const underWall =
    window.top !== window &&
    window.parent === window.top &&
    ancestors.length === 1 &&
    ancestors[0] === `chrome-extension://${chrome.runtime.id}`;
  if (!underWall) return;

  document.documentElement.dataset.webCell = 'active';

  /** The site rule of the stand-in: where the input, the button and the answers are. */
  const RULE = {
    input: '#prompt',
    submit: '#send',
    answer: '#answers .answer',
    finished: (element) => element.dataset.state === 'done',
    failed: (element) => element.dataset.state === 'failed',
  };

  const until = (condition, timeoutMs = 10_000) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const value = condition();
        if (value) resolve(value);
        else if (Date.now() - started > timeoutMs) reject(new Error('timeout'));
        else setTimeout(tick, 25);
      };
      tick();
    });

  function fill(input, text) {
    input.focus();
    if (input.isContentEditable) {
      input.textContent = text;
    } else {
      // A framework that tracks the value property sees the native setter.
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
      setter.call(input, text);
    }
    input.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
    );
  }

  async function ask(prompt) {
    const input = document.querySelector(RULE.input);
    const submit = document.querySelector(RULE.submit);
    if (!input || !submit) return { ok: false, reason: 'rule_failed' };
    const before = document.querySelectorAll(RULE.answer).length;
    fill(input, prompt);
    await until(() => !submit.disabled);
    submit.click();
    const answer = await until(() => document.querySelectorAll(RULE.answer)[before]);
    await until(() => RULE.finished(answer) || RULE.failed(answer));
    if (RULE.failed(answer)) return { ok: false, reason: 'site_failed', text: answer.textContent };
    return { ok: true, text: answer.textContent };
  }

  const port = chrome.runtime.connect({ name: 'web-cell' });
  port.onMessage.addListener((message) => {
    if (message.type !== 'ask') return;
    ask(message.prompt).then(
      (result) => port.postMessage({ id: message.id, ...result }),
      (error) => port.postMessage({ id: message.id, ok: false, reason: String(error.message) }),
    );
  });
})();
