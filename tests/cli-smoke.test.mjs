import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cliPath = 'dist/index.js';

async function runCli(args) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
  });
}

test('CLI prints version', async () => {
  const { stdout } = await runCli(['--version']);

  assert.equal(stdout.trim(), '0.1.2');
});

test('CLI help uses rakit command name', async () => {
  const { stdout } = await runCli(['--help']);

  assert.match(stdout, /Usage: rakit/);
  assert.match(stdout, /doctor/);
});

test('CLI about command prints runtime info', async () => {
  const { stdout } = await runCli(['about']);

  assert.match(stdout, /Version\s+0\.1\.2/);
  assert.match(stdout, /Runtime\s+Node\.js/);
});

test('CLI doctor command prints environment status', async () => {
  const { stdout } = await runCli(['doctor']);

  assert.match(stdout, /Rakit doctor/);
  assert.match(stdout, /version\s+0\.1\.2/);
  assert.match(stdout, /active ready/);
});
