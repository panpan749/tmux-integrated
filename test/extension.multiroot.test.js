const assert = require('node:assert/strict');
const events = require('node:events');
const Module = require('node:module');
const test = require('node:test');

const folders = [
  { name: 'resume', index: 0, uri: { fsPath: '/workspace/resume' } },
  { name: 'Applications', index: 1, uri: { fsPath: '/workspace/Applications' } },
];

class Disposable {
  dispose() {}
}

class EventEmitter {
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

class FakeTmuxControlClient extends events.EventEmitter {
  constructor(name) { super(); this.sessionName = name; }
  setVersion() {}

  versionAtLeast() {
    return true;
  }

  isConnected() {
    return true;
  }

  async connect() {}

  async listWindows() {
    return [{ id: '@1', paneId: '%1', index: 0, name: 'tmux:0', automaticRename: true }];
  }

  async sendCommand(command) {
    return command.includes('__ping__') ? ['__ping__'] : [];
  }

  async updateEnvironment() {}
}

for (const restored of [false, true, 'native']) test(`selected folder and session restoration (restored=${restored})`, async () => {
  const records = [];
  let nextId = 10;
  const existing = { sessionId: '$1', sessionName: 'renamed-session', windowId: '@1', paneId: '%1', windowIndex: 0, name: 'shell', directory: '/workspace/resume', managed: restored !== 'native' };
  const commands = new Map();
  const terminals = [];
  let profileProvider;
  const vscode = {
    Disposable,
    EventEmitter,
    StatusBarAlignment: { Left: 1 },
    TerminalProfile: class {
      constructor(options) {
        this.options = options;
      }
    },
    Uri: { parse: (value) => ({ value }) },
    env: { appRoot: '/mock/vscode', openExternal() {} },
    workspace: {
      workspaceFolders: folders,
      getConfiguration(section) {
        return {
          get(key, fallback) {
            if (section === 'tmux-integrated' && key === 'autoConnect') {
              return false;
            }
            return fallback;
          },
        };
      },
    },
    window: {
      terminals: [],
      createTerminal: options => { terminals.push(options); return { show() {} }; },
      createTreeView: () => ({ visible: false, dispose() {}, onDidChangeVisibility: () => new Disposable() }),
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {}, text: '', command: '' }),
      registerTerminalProfileProvider(_id, provider) {
        profileProvider = provider;
        return new Disposable();
      },
      showQuickPick: async (items) => items.find((item) => item.workspaceFolder?.index === 1),
      showErrorMessage: async () => undefined,
      showWarningMessage() {},
      onDidOpenTerminal: () => new Disposable(),
      onDidCloseTerminal: () => new Disposable(),
      onDidChangeActiveTerminal: () => new Disposable(),
    },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return new Disposable(); } },
  };

  const originalLoad = Module._load;
  Module._load = function loadMockedModule(request, parent, isMain) {
    if (request === 'vscode') {
      return vscode;
    }
    if (request === 'child_process') { return { execFileSync: () => 'tmux 3.5a' }; }
    if (request === './tmuxWindowStore') return {
      TmuxWindowStore: class {
        async list() { return restored ? [existing] : []; }
        async create(directory) {
          const id = nextId++;
          const window = { ...existing, sessionId: `$${id}`, windowId: `@${id}`, directory, sessionName: `new-${id}` };
          records.push(window);
          return window;
        }
      },
    };
    if (request.endsWith('/tmuxControlClient') || request === './tmuxControlClient') {
      return {
        TmuxControlClient: FakeTmuxControlClient,
        CommandFlags: { None: 0, TolerateErrors: 1 },
        shellescape: (value) => value,
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const extension = require('../out/extension.js');
    await extension.activate({
      extensionPath: '/extension',
      globalStorageUri: { fsPath: '/extension-storage' },
      subscriptions: [],
    });
    assert.ok(profileProvider, 'profile provider was registered');

    await commands.get('tmux-integrated.newTerminal')();
    await commands.get('tmux-integrated.newTerminal')();
    assert.equal(records.length, 2);
    assert.notEqual(terminals[0].pty.client.sessionName, terminals[1].pty.client.sessionName);
    assert.equal(terminals[0].pty.startDirectory, '/workspace/Applications');
    const profile = await profileProvider.provideTerminalProfile({ isCancellationRequested: false });
    if (restored === true) {
      assert.equal(profile.options.name, 'renamed-session');
      assert.equal(profile.options.pty.existingWindow.windowId, '@1');
      assert.equal(records.length, 2, 'restoring must not create another session');
    } else {
      assert.equal(records.length, 3);
      assert.equal(profile.options.pty.startDirectory, '/workspace/Applications');
    }
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../out/extension.js')];
  }
});
