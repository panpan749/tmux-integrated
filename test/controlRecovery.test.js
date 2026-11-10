const assert = require('node:assert/strict');
const test = require('node:test');
const { TmuxControlClient } = require('../out/tmuxControlClient');
const { TmuxGateway } = require('../out/tmuxGateway');

class FakePty {
  writes = [];
  blocked = false;
  onData(fn) { this.data = fn; return { dispose() {} }; }
  onExit(fn) { this.exit = fn; return { dispose() {} }; }
  write(command) {
    this.writes.push(command);
    const marker = command.match(/display-message -p "?(__tmux_integrated_\w+__)/)?.[1];
    if (marker && !this.blocked) {
      queueMicrotask(() => this.data(`%begin 1 1 1\n${marker}\n%end 1 1 1\n`));
    }
  }
  kill() { this.killed = true; }
}

function createClient() {
  const ptys = [];
  const client = new TmuxControlClient('$1', 'tmux', '/unused');
  client.requireNodePty = () => ({ spawn: () => {
    const pty = new FakePty();
    ptys.push(pty);
    queueMicrotask(() => pty.data('%begin 1 1 1\n%end 1 1 1\n%session-changed $1 test\n'));
    return pty;
  } });
  return { client, ptys };
}

test('health probe distinguishes responsive, stalled and disconnected channels, sharing in-flight checks', async () => {
  const { client, ptys } = createClient();
  await client.connect({ attachOnly: true });
  assert.equal(await client.checkHealth(100), true);
  ptys[0].blocked = true;
  const first = client.checkHealth(20);
  const second = client.checkHealth(20);
  assert.equal(first, second);
  assert.equal(await first, false);
  const pending = client.sendCommand('list-windows');
  const rejected = assert.rejects(pending, /exited/);
  client.disconnect();
  await rejected;
  assert.equal(await client.checkHealth(), false);
});

test('late output or exit from a discarded PTY cannot break the replacement channel', async () => {
  const { client, ptys } = createClient();
  await client.connect({ attachOnly: true });
  client.disconnect();
  await client.connect({ attachOnly: true });
  ptys[0].data('%exit\n');
  ptys[0].exit({ exitCode: 0 });
  assert.equal(client.isConnected(), true);
  assert.equal(await client.checkHealth(100), true);
  client.disconnect();
});

test('disconnect drops queued startup writes as well as rejecting pending responses', async () => {
  const gateway = new TmuxGateway();
  const writes = [];
  gateway.setWriter(data => writes.push(data));
  const result = gateway.sendCommand('send-keys Enter');
  const rejected = assert.rejects(result, /exited/);
  gateway.drainOnExit();
  gateway.ingest('%session-changed $1 test\n');
  await rejected;
  await assert.rejects(gateway.sendCommand('list-windows'), /exited/);
  await assert.rejects(gateway.sendCommandList(['list-windows']), /exited/);
  assert.deepEqual(writes, [], 'queued input must not be sent after disposal');
});
