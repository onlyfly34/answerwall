import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { createProcessRuntime, SHUTDOWN_MESSAGE } from './process-runtime.ts';
import type { HostProcess } from './process-runtime.ts';

class FakeStream extends EventEmitter {
  written: string[] = [];
  isTTY = false;
  failWith: Error | undefined;

  write(text: string): boolean {
    if (this.failWith) throw this.failWith;
    this.written.push(text);
    return true;
  }
}

class FakeHost extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  channel: { unref(): void } | undefined;
  channelUnref = vi.fn();
}

const withChannel = (): FakeHost => {
  const host = new FakeHost();
  host.channel = { unref: () => void host.channelUnref() };
  return host;
};

const host = (fake: FakeHost): HostProcess => fake;

describe('output', () => {
  test('lines go to their stream, one per call', () => {
    const fake = new FakeHost();
    const runtime = createProcessRuntime(host(fake));

    runtime.stdout('to out');
    runtime.stderr('to err');

    expect(fake.stdout.written).toEqual(['to out\n']);
    expect(fake.stderr.written).toEqual(['to err\n']);
    expect(runtime.stdoutIsTty).toBe(false);
  });

  test.each([
    ['a closed pipe', 'EPIPE'],
    ['a closed terminal', 'EIO'],
  ])('%s does not end the process and ends the writing', (_name, code) => {
    const fake = new FakeHost();
    const runtime = createProcessRuntime(host(fake));
    runtime.stdout('before');

    // Node reports a failed pipe write through this event; unheard, it is an uncaught exception.
    expect(fake.stdout.listenerCount('error')).toBe(1);
    expect(fake.stderr.listenerCount('error')).toBe(1);
    fake.stdout.emit('error', Object.assign(new Error(`write ${code}`), { code }));
    runtime.stdout('after');
    runtime.stderr('still heard');

    expect(fake.stdout.written).toEqual(['before\n']);
    expect(fake.stderr.written).toEqual(['still heard\n']);
  });

  test('a write that throws is survived too', () => {
    const fake = new FakeHost();
    const runtime = createProcessRuntime(host(fake));
    fake.stdout.failWith = new Error('stream destroyed');

    expect(() => runtime.stdout('lost')).not.toThrow();
  });
});

describe('requests to stop', () => {
  test('a signal reaches its handler until the handler is removed', () => {
    const fake = new FakeHost();
    const handler = vi.fn();
    const remove = createProcessRuntime(host(fake)).onSignal('SIGHUP', handler);

    fake.emit('SIGHUP');
    expect(handler).toHaveBeenCalledTimes(1);

    remove();
    expect(fake.listenerCount('SIGHUP')).toBe(0);
  });

  test('a supervisor stops the server with the shutdown message', () => {
    const fake = withChannel();
    const handler = vi.fn();
    const remove = createProcessRuntime(host(fake)).onSignal('SIGTERM', handler);

    fake.emit('message', 'something else');
    expect(handler).not.toHaveBeenCalled();
    fake.emit('message', SHUTDOWN_MESSAGE);
    expect(handler).toHaveBeenCalledTimes(1);
    // The channel alone must not keep the process alive.
    expect(fake.channelUnref).toHaveBeenCalled();

    remove();
    expect(fake.listenerCount('message')).toBe(0);
    expect(fake.listenerCount('disconnect')).toBe(0);
  });

  test('a supervisor that disappears stops the server', () => {
    const fake = withChannel();
    const handler = vi.fn();
    createProcessRuntime(host(fake)).onSignal('SIGTERM', handler);

    fake.emit('disconnect');

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('a supervisor that asks for a shutdown and then exits does not cut it short', () => {
    const fake = withChannel();
    const runtime = createProcessRuntime(host(fake));
    const onInterrupt = vi.fn();
    const onTerminate = vi.fn();
    runtime.onSignal('SIGINT', onInterrupt);
    runtime.onSignal('SIGTERM', onTerminate);

    fake.emit('SIGINT');
    fake.emit('disconnect');

    // A second call would be taken for a second signal.
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onTerminate).not.toHaveBeenCalled();
  });

  test('without an IPC channel only the signal is listened for', () => {
    const fake = new FakeHost();
    createProcessRuntime(host(fake)).onSignal('SIGTERM', vi.fn());

    expect(fake.eventNames()).toEqual(['SIGTERM']);
  });
});

describe('child processes', () => {
  test('are killed when the process exits, whatever the reason', () => {
    const fake = new FakeHost();
    const killChildren = vi.fn();
    const runtime = createProcessRuntime(host(fake), killChildren);

    expect(runtime.killChildren).toBe(killChildren);
    fake.emit('exit', 1);

    expect(killChildren).toHaveBeenCalledTimes(1);
  });

  test('nothing is registered when the core library offers no way to kill them', () => {
    const fake = new FakeHost();
    const runtime = createProcessRuntime(host(fake));

    expect(runtime.killChildren).toBeUndefined();
    expect(fake.listenerCount('exit')).toBe(0);
  });
});
