const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const events = require('node:events');

const commands = new Map();
const opened = [];
const connections = [];
const errors = [];
const operations = [];
let closeListener, selection, input;
const window = { sessionId: '$9', sessionName: 'another-project', windowId: '@8', paneId: '%4',
  windowIndex: 1, name: 'build', directory: '/other/project', automaticRename: false };
const disposable = () => ({ dispose() {} });
class Emitter {
  emitter = new events.EventEmitter();
  event = listener => { this.emitter.on('event', listener); return disposable(); };
  fire(value) { this.emitter.emit('event', value); }
  dispose() {}
}
class Client extends events.EventEmitter {
  constructor(sessionId) { super(); this.sessionId = sessionId; connections.push(this); }
  async connect(options) { this.options = options; this.healthy = true; }
  async checkHealth() { return this.healthy; }
  setVersion() {}
  async updateEnvironment() {}
  disconnect() { this.disconnected = true; }
}
const vscode = {
  EventEmitter: Emitter,
  TerminalExitReason: { User: 3, Extension: 4 },
  StatusBarAlignment: { Left: 1 },
  env: { appRoot: '/mock' },
  workspace: {
    getConfiguration: () => ({ get: (key, fallback) => key === 'autoConnect' ? false : fallback }),
  },
  window: {
    terminals: [],
    createOutputChannel: () => ({ ...disposable(), appendLine() {} }),
    createStatusBarItem: () => ({ ...disposable(), show() {} }),
    createTreeView: () => ({ ...disposable(), visible: false, onDidChangeVisibility: disposable }),
    registerTerminalProfileProvider: disposable,
    onDidOpenTerminal: disposable,
    onDidCloseTerminal: callback => { closeListener = callback; return disposable(); },
    onDidChangeActiveTerminal: disposable,
    createTerminal: options => {
      const terminal = { creationOptions: options, name: options.name, shown: 0,
        show() { this.shown++; },
        dispose() { this.disposed = true; options.pty.close(); options.pty.noteTerminalExitReason(4); closeListener(this); } };
      opened.push(terminal);
      return terminal;
    },
    showInputBox: async () => input,
    showWarningMessage: async () => selection,
    showErrorMessage: async message => errors.push(message),
  },
  commands: { registerCommand: (id, action) => { commands.set(id, action); return disposable(); } },
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  if (request === 'child_process') return { execFileSync: () => 'tmux 3.5a' };
  if (request === './tmuxControlClient') return { TmuxControlClient: Client, CommandFlags: {} };
  if (request === './tmuxWindowStore') return {
    TmuxWindowStore: class {
      async list() { return [window]; }
      async find(value) { return value; }
      async findSession(value) { return { ...value, windows: [window] }; }
      async create(directory) { operations.push(['create', directory]); return { ...window, sessionId: '$10', windowId: '@10', directory }; }
      async renameSession(value, name) { operations.push(['rename-session', value.sessionId, name]); }
      async deleteSession(value) { operations.push(['delete-session', value.sessionId]); }
      async rename(value, name) { operations.push(['rename', value.windowId, name]); }
      async delete(value) { operations.push(['delete', value.windowId]); }
    },
  };
  return originalLoad(request, parent, isMain);
};
const extension = require('../out/extension');
Module._load = originalLoad;

test('sidebar commands attach across sessions once, rename, confirm delete and reopen closed tabs', async () => {
  const subscriptions = [];
  await extension.activate({ extensionPath: '/extension', globalStorageUri: { fsPath: '/storage' }, subscriptions });
  try {
    const attach = commands.get('tmux-integrated.treeAttach');
    await Promise.all([attach(window), attach(window)]);
    assert.equal(connections.length, 1);
    assert.equal(connections[0].sessionId, '$9');
    assert.deepEqual(connections[0].options, { attachOnly: true });
    assert.equal(opened.length, 1);
    assert.ok(opened[0].shown >= 1);
    assert.equal(opened[0].creationOptions.pty.startDirectory, '/other/project');
    assert.equal(opened[0].creationOptions.pty.destroyWindowOnClose(), false);
    await attach(window);
    assert.equal(opened.length, 1);
    closeListener(opened[0]);
    await attach(window);
    assert.equal(opened.length, 2);

    const oldTab = opened.at(-1);
    connections[0].healthy = false;
    await attach(window);
    assert.equal(oldTab.disposed, true, 'unresponsive connection replaces the old tab');
    assert.equal(oldTab.creationOptions.pty.preserveOnClose, true, 'repair never applies destroy-on-close');
    assert.equal(connections.length, 2);
    assert.deepEqual(operations, [], 'reconnect never deletes or recreates the session');
    connections[0].emit('tmux-exit');
    await attach(window);
    assert.equal(connections.length, 2, 'late exit from old client must not evict the new connection');
    const replaced = opened.at(-1);
    await commands.get('tmux-integrated.reconnectTerminal')(window);
    assert.equal(replaced.disposed, true, 'explicit reconnect also repairs a healthy backend with a broken frontend tab');
    assert.equal(connections.length, 3);
    assert.deepEqual(operations, []);

    input = undefined;
    await commands.get('tmux-integrated.treeRename')(window);
    assert.deepEqual(operations, []);
    input = 'new name';
    await commands.get('tmux-integrated.treeRename')(window);
    assert.deepEqual(operations, [['rename-session', '$9', 'new name']]);
    selection = undefined;
    await commands.get('tmux-integrated.treeDelete')(window);
    assert.equal(operations.length, 1, 'cancel must not delete');
    selection = 'Delete';
    await commands.get('tmux-integrated.treeDelete')(window);
    assert.deepEqual(operations.at(-1), ['delete-session', '$9']);
    const session = { sessionId: '$9', sessionName: 'another-project', windows: [window], directory: window.directory };
    input = 'renamed-session';
    await commands.get('tmux-integrated.renameSession')(session);
    assert.deepEqual(operations.at(-1), ['rename-session', '$9', 'renamed-session']);
    selection = undefined;
    const before = operations.length;
    await commands.get('tmux-integrated.deleteSession')(session);
    assert.equal(operations.length, before);
    selection = 'Delete Session';
    await commands.get('tmux-integrated.deleteSession')(session);
    assert.deepEqual(operations.at(-1), ['delete-session', '$9']);
    assert.deepEqual(errors, []);
    const create = commands.get('tmux-integrated.newTerminalInDirectory');
    input = undefined;
    const beforeCreate = operations.length;
    await create();
    assert.equal(operations.length, beforeCreate, 'cancel does not create a session');
    input = '/this-directory-does-not-exist-tmux-test';
    await create();
    assert.equal(operations.length, beforeCreate, 'invalid path does not create a session');
    assert.match(errors.pop(), /does not exist/);
    const fs = require('node:fs');
    const directory = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tmux custom '));
    try {
      input = directory;
      await create();
      assert.deepEqual(operations.at(-1), ['create', directory]);
      assert.equal(opened.at(-1).creationOptions.pty.startDirectory, directory);
      assert.deepEqual(errors, []);
    } finally { fs.rmSync(directory, { recursive: true }); }
  } finally { subscriptions.forEach(d => d.dispose()); }
});
