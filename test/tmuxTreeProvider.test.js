const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const events = require('node:events');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return {
    EventEmitter: class {
      emitter = new events.EventEmitter();
      event = listener => { this.emitter.on('change', listener); return { dispose() {} }; };
      fire(value) { this.emitter.emit('change', value); }
      dispose() { this.emitter.removeAllListeners(); }
    },
    TreeItem: class { constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    TreeItemCollapsibleState: { None: 0, Expanded: 2 },
  };
  return originalLoad(request, parent, isMain);
};
const { TmuxTreeProvider } = require('../out/tmuxTreeProvider');
Module._load = originalLoad;
const window = (windowId, directory, name, sessionName = name) => ({
  windowId, directory, name, sessionName, sessionId: '$' + windowId.slice(1), paneId: '%1', windowIndex: 0,
});

test('tree shows one terminal per session under directories', async () => {
  const a = window('@1', '/one/project', 'alpha');
  const b = window('@2', '/two/project', 'beta');
  const provider = new TmuxTreeProvider({ list: async () => [b, a, { ...a, sessionId: '$3' }] }, () => {});
  try {
    const groups = await provider.getChildren();
    assert.deepEqual(groups.map(g => g.directory), ['/one/project', '/two/project']);
    const terminals = await provider.getChildren(groups[0]);
    assert.equal(terminals.length, 2);
    assert.equal(provider.getTreeItem(terminals[0]).contextValue, 'tmuxWindow');
    assert.equal(provider.getTreeItem(terminals[0]).label, 'alpha');
    assert.deepEqual(await provider.getChildren(terminals[0]), []);
    assert.notEqual(provider.getTreeItem(groups[0]).id, provider.getTreeItem(groups[1]).id);
    const item = provider.getTreeItem(a);
    assert.equal(item.label, 'alpha');
    assert.equal(item.contextValue, 'tmuxWindow');
    assert.equal(item.command.command, 'tmux-integrated.treeAttach');
    assert.deepEqual(item.command.arguments, [a]);
    assert.deepEqual(await provider.getChildren(a), []);
  } finally { provider.dispose(); }
});

test('visible tree notices external changes and stops polling when hidden', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let rows = [window('@1', '/one', 'old')], calls = 0, changed = 0;
  const provider = new TmuxTreeProvider({ list: async () => { calls++; return rows; } }, () => {});
  provider.onDidChangeTreeData(() => changed++);
  await provider.getChildren();
  provider.setVisible(true);
  rows = [window('@1', '/one', 'new')];
  t.mock.timers.tick(3000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(changed, 2);
  assert.equal(provider.getTreeItem((await provider.getChildren())[0].windows[0]).label, 'new');
  provider.setVisible(false);
  const lastCalls = calls;
  t.mock.timers.tick(6000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, lastCalls);
  provider.dispose();
});

test('listing failure is reported and clears after recovery', async () => {
  let failed = true;
  const errors = [];
  const provider = new TmuxTreeProvider({ list: async () => {
    if (failed) throw new Error('tmux unavailable');
    return [];
  } }, error => errors.push(error));
  assert.deepEqual(await provider.getChildren(), []);
  assert.match(errors.at(-1), /tmux unavailable/);
  failed = false;
  await provider.getChildren();
  assert.equal(errors.at(-1), undefined);
  provider.dispose();
});
