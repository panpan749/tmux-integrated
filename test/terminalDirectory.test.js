const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveTerminalDirectory } = require('../out/terminalDirectory');

test('directory input accepts absolute, relative and home paths and rejects files and missing paths', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmux-directory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, '项目 with spaces');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(root, 'file.txt'), 'not a directory');
  assert.equal(await resolveTerminalDirectory(folder, '/unused'), folder);
  assert.equal(await resolveTerminalDirectory('项目 with spaces', root), folder);
  assert.equal(await resolveTerminalDirectory('~/项目 with spaces', '/unused', root), folder);
  assert.equal(await resolveTerminalDirectory('~', '/unused', root), root);
  await assert.rejects(resolveTerminalDirectory('', root), /Enter a directory/);
  await assert.rejects(resolveTerminalDirectory('file.txt', root), /Not a directory/);
  await assert.rejects(resolveTerminalDirectory('missing', root), /does not exist/);
});
