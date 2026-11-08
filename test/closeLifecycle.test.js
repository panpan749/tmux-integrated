/**
 * Tests for what happens to a tmux window when its VS Code tab closes.
 *
 * Windows are preserved by default. With destroyWindowOnClose enabled,
 * only a deliberate close of that one tab kills the tmux window. A window/workspace teardown must leave it running so the next
 * activation can re-adopt it.
 *
 * Every test here runs with `isDeactivating: () => false`, i.e. the extension
 * is never deactivated — this reproduces a Remote-SSH host that drops the
 * workbench connection without shutting the extension host down. The previous
 * implementation raced `close()` against `deactivate()` on a 300ms timer and
 * in exactly that situation killed every window in the session, taking the
 * session (and the user's running processes) with it.
 */
const assert = require('node:assert/strict');
const events = require('node:events');
const Module = require('node:module');
const test = require('node:test');

class Disposable {
  dispose() {}
}

class VscodeEventEmitter {
  constructor() {
    this.emitter = new events.EventEmitter();
    this.event = (listener) => {
      this.emitter.on('event', listener);
      return new Disposable();
    };
  }

  fire(value) {
    this.emitter.emit('event', value);
  }
}

// Mirrors vscode.TerminalExitReason.
const TerminalExitReason = {
  Unknown: 0,
  Shutdown: 1,
  Process: 2,
  User: 3,
  Extension: 4,
};

const vscodeMock = { Disposable, EventEmitter: VscodeEventEmitter, TerminalExitReason };
const originalLoad = Module._load;
Module._load = function loadMockedModule(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeMock;
  }
  return originalLoad(request, parent, isMain);
};
const { TmuxTerminal } = require('../out/tmuxTerminalProvider.js');
Module._load = originalLoad;

class FakeTmuxClient extends events.EventEmitter {
  constructor() {
    super();
    this.commands = [];
    this.connected = true;
  }

  isConnected() {
    return this.connected;
  }

  async sendCommand(command) {
    this.commands.push(command);
    return [];
  }

  async sendCommandList(commands) {
    this.commands.push(...commands);
    return commands.map(() => []);
  }

  async newWindow() {
    return { windowId: '@7', paneId: '%9', windowIndex: 5 };
  }

  async getWindowIndex() {
    return 5;
  }

  async getWindowName() {
    return 'tmux:5';
  }

  async getWindowAutomaticRename() {
    return true;
  }

  async resizeWindowForClient() {}

  async capturePane() {
    return '';
  }

  async getPaneCursor() {
    return { x: 0, y: 0 };
  }

  removePaneDecoder() {}
}

async function openTerminal(client, { isDeactivating = () => false, destroyWindowOnClose = () => true } = {}) {
  const pty = new TmuxTerminal(
    client,
    undefined,
    {},
    '/bin/bash',
    false,
    undefined,
    undefined,
    isDeactivating,
    () => {},
    destroyWindowOnClose,
  );
  await pty.open(undefined);
  client.commands.length = 0;
  return pty;
}

const killedWindows = (client) => client.commands.filter((c) => c.startsWith('kill-window'));

test('user closing the tab kills the tmux window', async () => {
  const client = new FakeTmuxClient();
  const pty = await openTerminal(client);

  pty.close();
  pty.noteTerminalExitReason(TerminalExitReason.User);

  assert.deepEqual(killedWindows(client), ['kill-window -t @7']);
});

test('an extension disposing the terminal kills the tmux window', async () => {
  const client = new FakeTmuxClient();
  const pty = await openTerminal(client);

  pty.close();
  pty.noteTerminalExitReason(TerminalExitReason.Extension);

  assert.deepEqual(killedWindows(client), ['kill-window -t @7']);
});

test('window reload / workspace switch leaves the tmux window alive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new FakeTmuxClient();
  const pty = await openTerminal(client);

  pty.close();
  pty.noteTerminalExitReason(TerminalExitReason.Shutdown);
  t.mock.timers.tick(60_000);

  assert.deepEqual(killedWindows(client), []);
});

test('no exit reason at all leaves the tmux window alive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new FakeTmuxClient();
  const pty = await openTerminal(client);

  // The workbench connection died before telling us why the tab closed.
  pty.close();
  t.mock.timers.tick(60_000);

  assert.deepEqual(killedWindows(client), []);
});

test('an unknown exit reason leaves the tmux window alive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new FakeTmuxClient();
  const pty = await openTerminal(client);

  pty.close();
  pty.noteTerminalExitReason(TerminalExitReason.Unknown);
  t.mock.timers.tick(60_000);

  assert.deepEqual(killedWindows(client), []);
});

test('a window tmux already closed is not killed again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new FakeTmuxClient();
  const pty = await openTerminal(client);

  // The shell exited: tmux closes the window and the tab follows.
  client.emit('window-close', '@7');
  pty.close();
  pty.noteTerminalExitReason(TerminalExitReason.Process);
  t.mock.timers.tick(60_000);

  assert.deepEqual(killedWindows(client), []);
});

test('the exit reason is honoured even when it arrives before close()', async () => {
  const client = new FakeTmuxClient();
  const pty = await openTerminal(client);

  pty.noteTerminalExitReason(TerminalExitReason.User);
  pty.close();

  assert.deepEqual(killedWindows(client), ['kill-window -t @7']);
});

test('a deactivating extension never kills a window', async () => {
  const client = new FakeTmuxClient();
  const pty = await openTerminal(client, { isDeactivating: () => true });

  pty.close();
  pty.noteTerminalExitReason(TerminalExitReason.User);

  assert.deepEqual(killedWindows(client), []);
});

test('the window is killed at most once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new FakeTmuxClient();
  const pty = await openTerminal(client);

  pty.close();
  pty.noteTerminalExitReason(TerminalExitReason.User);
  pty.noteTerminalExitReason(TerminalExitReason.User);
  t.mock.timers.tick(60_000);

  assert.deepEqual(killedWindows(client), ['kill-window -t @7']);
});

for (const reason of [TerminalExitReason.User, TerminalExitReason.Extension]) {
  test(`default close preserves window for reason ${reason}, regardless of event order`, async () => {
    for (const reasonFirst of [true, false]) {
      const client = new FakeTmuxClient();
      // Undefined uses the constructor's safe default, as new users do.
      const pty = new TmuxTerminal(client, undefined, {}, '/bin/bash');
      await pty.open(undefined);
      client.commands.length = 0;
      if (reasonFirst) pty.noteTerminalExitReason(reason);
      pty.close();
      if (!reasonFirst) pty.noteTerminalExitReason(reason);
      assert.deepEqual(killedWindows(client), []);
    }
  });
}

test('changing the setting on an already open tab takes effect at close', async () => {
  let destroy = true;
  const client = new FakeTmuxClient();
  const pty = await openTerminal(client, { destroyWindowOnClose: () => destroy });
  destroy = false;
  pty.close();
  pty.noteTerminalExitReason(TerminalExitReason.User);
  assert.deepEqual(killedWindows(client), []);
});
