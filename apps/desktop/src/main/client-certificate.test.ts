import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import { refuseClientCertificates } from './client-certificate.ts';

describe('refuseClientCertificates', () => {
  test('a server that asks for a client certificate is offered none', () => {
    const app = new EventEmitter();
    refuseClientCertificates(app);
    let prevented = 0;
    const answers: unknown[][] = [];

    const handled = app.emit(
      'select-client-certificate',
      { preventDefault: () => void (prevented += 1) },
      {},
      'https://wall.example/',
      [{ subjectName: 'A person' }, { subjectName: 'Another' }],
      (...chosen: unknown[]) => void answers.push(chosen),
    );

    expect(handled).toBe(true);
    // Electron's own choice (the first certificate) is switched off …
    expect(prevented).toBe(1);
    // … and the request is answered once, with no certificate.
    expect(answers).toEqual([[]]);
  });
});
