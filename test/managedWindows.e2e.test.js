const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { TmuxControlClient } = require('../out/tmuxControlClient');
const { TmuxWindowStore, markManagedWindow } = require('../out/tmuxWindowStore');

let available = true;
try { execFileSync('tmux', ['-V']); require('node-pty'); } catch { available = false; }

test('managed windows: discover across sessions, preserve markers, rename, delete and attach only',
  { skip: available ? false : 'tmux or node-pty unavailable' }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-managed-'));
    const wrapper = path.join(dir, 'tmux');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec tmux -f /dev/null -L managed-${process.pid} "$@"\n`, { mode: 0o755 });
    const store = new TmuxWindowStore(() => wrapper);
    const clients = [];
    t.after(async () => {
      for (const client of clients) client.disconnect();
      try { await store.run(['kill-server']); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    });
    assert.deepEqual(await store.list(), []);
    for (const session of ['project-one', 'project-two']) {
      const client = new TmuxControlClient(session, wrapper, path.resolve(__dirname, '..'));
      client.setVersion(execFileSync('tmux', ['-V'], { encoding: 'utf8' }));
      clients.push(client);
      await client.connect({ startDirectory: dir });
    }
    const [first] = await clients[0].listWindows();
    const [second] = await clients[1].listWindows();
    assert.equal((await store.list()).length, 2, 'native sessions are listed before being marked');
    assert.ok((await store.list()).every(w => w.managed === false));
    const specialDirectory = '/workspace/项目 with spaces|quotes\'test';
    await markManagedWindow(clients[0], first.id, specialDirectory);
    await markManagedWindow(clients[0], first.id, '/must-not-overwrite');
    await markManagedWindow(clients[1], second.id, dir);
    let windows = await store.list();
    assert.equal(windows.length, 2);
    const selected = windows.find(w => w.windowId === first.id);
    assert.equal(selected.directory, specialDirectory);
    assert.equal(windows.find(w => w.windowId === second.id).directory, dir);

    const observer = new TmuxControlClient(selected.sessionId, wrapper, path.resolve(__dirname, '..'));
    observer.setVersion(execFileSync('tmux', ['-V'], { encoding: 'utf8' }));
    clients.push(observer);
    await observer.connect({ attachOnly: true });
    assert.equal((await observer.listWindows())[0].id, first.id);
    const name = 'renamed "quoted" | 中文 ; not-a-command';
    await store.rename(selected, name);
    assert.equal(await observer.getWindowName(first.id), name);
    assert.equal(await observer.getWindowAutomaticRename(first.id), false);
    await store.delete(selected);
    windows = await store.list();
    assert.deepEqual(windows.map(w => w.windowId), [second.id]);
    await assert.rejects(store.find(selected), /no longer exists/);
    await assert.rejects(store.delete(selected), /no longer exists/);

    const stale = new TmuxControlClient(selected.sessionId, wrapper, path.resolve(__dirname, '..'));
    clients.push(stale);
    await assert.rejects(stale.connect({ attachOnly: true }));
    assert.equal((await store.run(['list-sessions', '-F', '#{session_name}'])).trim(), 'project-two');
  });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, 'timed out waiting for external client');
    await sleep(25);
  }
}

test('session rename matches tmux ls; session deletion exits external attach even with detach-on-destroy off',
  { skip: available ? false : 'tmux or node-pty unavailable' }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-session-'));
    const wrapper = path.join(dir, 'tmux');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec tmux -f /dev/null -L session-${process.pid} "$@"\n`, { mode: 0o755 });
    const store = new TmuxWindowStore(() => wrapper);
    const control = new TmuxControlClient('victim', wrapper, path.resolve(__dirname, '..'));
    let external;
    t.after(async () => {
      control.disconnect();
      try { external?.kill(); } catch {}
      try { await store.run(['kill-server']); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    });
    await control.connect({ startDirectory: dir });
    const [window] = await control.listWindows();
    await markManagedWindow(control, window.id, dir);
    const extraId = (await store.run(['new-window', '-t', 'victim', '-n', 'previously-hidden', '-P', '-F', '#{window_id}'])).trim();
    await store.run(['new-session', '-d', '-s', 'unrelated']);
    await store.run(['set-option', '-g', 'detach-on-destroy', 'off']);
    const rows = await store.list();
    assert.ok(rows.some(w => w.windowId === extraId), 'bootstrap/unmarked siblings in managed sessions remain visible');
    const selected = rows.find(w => w.windowId === window.id);
    const session = { ...selected, windows: rows };
    external = require('node-pty').spawn(wrapper, ['attach-session', '-t', 'victim'], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: dir, env: process.env,
    });
    let exited = false;
    external.onData(() => {});
    external.onExit(() => { exited = true; });
    await until(async () => (await store.run(['list-clients', '-t', session.sessionId, '-F', '#{client_control_mode}'])).split('\n').includes('0'));
    await assert.rejects(store.renameSession(session, 'invalid.name'), /periods/);
    await assert.rejects(store.renameSession(session, 'unrelated'), /duplicate session/);
    await store.renameSession(session, 'renamed-project');
    assert.match(await store.run(['list-sessions', '-F', '#{session_name}']), /renamed-project/);
    assert.doesNotMatch(await store.run(['list-sessions', '-F', '#{session_name}']), /victim/);
    assert.equal(exited, false, 'rename preserves attached client');
    await control.updateEnvironment({ TMUX_INTEGRATED_TEST: 'after-rename' });
    assert.match(await store.run(['show-environment', '-t', session.sessionId, 'TMUX_INTEGRATED_TEST']), /after-rename/);
    // Removing a window keeps the sibling session visible and the external client alive.
    await store.delete(selected);
    assert.equal(exited, false);
    assert.ok((await store.list()).some(w => w.windowId === extraId));
    // Deleting the session must exit rather than switch the external client to unrelated.
    await store.deleteSession(session);
    await until(() => exited);
    assert.equal((await store.run(['list-sessions', '-F', '#{session_name}'])).trim(), 'unrelated');
    assert.deepEqual((await store.list()).map(w => w.sessionName), ['unrelated']);
    await assert.rejects(store.deleteSession(session), /no longer exists/);
  });

test('two terminals in one directory own separate single-window sessions and share shell context only when attached to the same one',
  { skip: available ? false : 'tmux or node-pty unavailable' }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-independent-'));
    const wrapper = path.join(dir, 'tmux');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec tmux -f /dev/null -L independent-${process.pid} "$@"\n`, { mode: 0o755 });
    const store = new TmuxWindowStore(() => wrapper);
    const clients = [];
    t.after(async () => {
      clients.forEach(c => c.disconnect());
      try { await store.run(['kill-server']); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const [one, two] = await Promise.all([store.create(dir, 'terminal', '/bin/bash'), store.create(dir, 'terminal', '/bin/bash')]);
    assert.notEqual(one.sessionId, two.sessionId);
    assert.notEqual(one.sessionName, two.sessionName);
    assert.equal((await store.run(['display-message', '-t', one.paneId, '-p', '#{pane_current_path}'])).trim(), dir,
      'the actual shell starts in the selected directory');
    assert.deepEqual((await store.run(['list-sessions', '-F', '#{session_windows}'])).trim().split('\n'), ['1', '1']);
    for (let i = 0; i < 2; i++) {
      const client = new TmuxControlClient(one.sessionId, wrapper, path.resolve(__dirname, '..'));
      clients.push(client);
      await client.connect({ attachOnly: true });
    }
    await clients[0].sendCommand(`send-keys -t ${one.paneId} 'export SHARED_CONTEXT=shared-value' Enter`);
    await clients[1].sendCommand(`send-keys -t ${one.paneId} 'printf "CTX:%s" "$SHARED_CONTEXT"' Enter`);
    await until(async () => (await clients[1].capturePane(one.paneId)).includes('CTX:shared-value'));
    const session = { ...one, windows: [one] };
    await store.renameSession(session, 'renamed-independent');
    assert.equal((await store.find(one)).sessionName, 'renamed-independent');
    assert.equal((await store.find(two)).sessionName, two.sessionName);
    await store.deleteSession(session);
    assert.deepEqual((await store.list()).map(w => w.sessionId), [two.sessionId]);
  });

test('native CLI sessions are listed without adoption and attach to the active window without creating anything',
  { skip: available ? false : 'tmux or node-pty unavailable' }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-native-'));
    const cwd = path.join(dir, '原生 space');
    fs.mkdirSync(cwd);
    const wrapper = path.join(dir, 'tmux');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec tmux -f /dev/null -L native-${process.pid} "$@"\n`, { mode: 0o755 });
    const store = new TmuxWindowStore(() => wrapper);
    let connection;
    t.after(async () => {
      connection?.disconnect();
      try { await store.run(['kill-server']); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    });
    await store.run(['new-session', '-d', '-s', 'native-cli', '-c', cwd]);
    const activeId = (await store.run(['new-window', '-t', 'native-cli', '-c', cwd, '-P', '-F', '#{window_id}'])).trim();
    const rows = await store.list();
    assert.equal(rows.length, 2);
    assert.ok(rows.every(w => !w.managed));
    assert.equal(rows[0].windowId, activeId);
    assert.equal(rows[0].directory, cwd);
    const before = await store.run(['list-windows', '-a', '-F', '#{session_id}:#{window_id}:#{pane_id}']);
    connection = new TmuxControlClient(rows[0].sessionId, wrapper, path.resolve(__dirname, '..'));
    await connection.connect({ attachOnly: true });
    assert.equal(await store.run(['list-windows', '-a', '-F', '#{session_id}:#{window_id}:#{pane_id}']), before);
    assert.equal((await store.run(['show-options', '-t', rows[0].sessionId])).includes('@tmux-integrated'), false);
    const session = { ...rows[0], windows: rows };
    await store.renameSession(session, 'renamed-native');
    assert.equal((await store.run(['list-sessions', '-F', '#{session_name}'])).trim(), 'renamed-native');
    await store.deleteSession(session);
    assert.deepEqual(await store.list(), []);
  });

test('replace a stalled control connection without restarting the session or replaying input',
  { skip: available ? false : 'tmux or node-pty unavailable' }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-recovery-'));
    const wrapper = path.join(dir, 'tmux');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec tmux -f /dev/null -L recovery-${process.pid} "$@"\n`, { mode: 0o755 });
    const store = new TmuxWindowStore(() => wrapper);
    const clients = [];
    t.after(async () => {
      clients.forEach(client => client.disconnect());
      try { await store.run(['kill-server']); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const window = await store.create(dir, 'recovery', '/bin/bash');
    const original = new TmuxControlClient(window.sessionId, wrapper, path.resolve(__dirname, '..'));
    clients.push(original);
    await original.connect({ attachOnly: true });
    const panePid = await store.run(['display-message', '-p', '-t', window.paneId, '#{pane_pid}']);
    await original.sendCommand(`send-keys -t ${window.paneId} 'export RECOVERY_CONTEXT=survived' Enter`);
    assert.equal(await original.checkHealth(1000), true);
    // Reproduce a live process whose protocol channel stops delivering commands.
    original.gateway.setWriter(() => {});
    const input = original.sendCommand(`send-keys -t ${window.paneId} 'export SHOULD_NOT_REPLAY=bad' Enter`);
    const rejected = assert.rejects(input, /exited/);
    assert.equal(await original.checkHealth(50), false);
    original.disconnect();
    await rejected;
    const restored = new TmuxControlClient(window.sessionId, wrapper, path.resolve(__dirname, '..'));
    clients.push(restored);
    await restored.connect({ attachOnly: true });
    assert.equal(await restored.checkHealth(1000), true);
    assert.equal(await store.run(['display-message', '-p', '-t', window.paneId, '#{pane_pid}']), panePid);
    await restored.sendCommand(`send-keys -t ${window.paneId} 'printf "RESULT:%s:%s" "$RECOVERY_CONTEXT" "\${SHOULD_NOT_REPLAY:-empty}"' Enter`);
    await until(async () => (await restored.capturePane(window.paneId)).includes('RESULT:survived:empty'));
    assert.equal((await store.list()).length, 1);
  });
