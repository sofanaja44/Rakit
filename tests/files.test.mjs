import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyFileAction,
  applyFileActions,
  buildPromptFileContext,
  extractFileActions,
  findProjectFiles,
  inspectProject,
  listProjectTree,
  readTextFile,
  writeTextFile,
} from '../dist/files.js';

async function withTempCwd(fn) {
  const previousCwd = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rakit-test-'));
  process.chdir(dir);
  try {
    await fn(dir);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('extractFileActions parses file, mkdir, delete, and command actions', () => {
  const parsed = extractFileActions(`Halo
<rakit_mkdir path="src/components"/>
<rakit_file path="src/index.ts">
export const ok = true;
</rakit_file>
<rakit_patch path="src/index.ts">
<<<<<<< SEARCH
export const ok = false;
=======
export const ok = true;
>>>>>>> REPLACE
</rakit_patch>
<rakit_delete path="old.txt"/>
<rakit_command cwd=".">
npm test
</rakit_command>`);

  assert.equal(parsed.displayText, 'Halo');
  assert.deepEqual(parsed.actions, [
    { kind: 'mkdir', filePath: 'src/components' },
    { kind: 'write', filePath: 'src/index.ts', content: 'export const ok = true;' },
    {
      kind: 'patch',
      filePath: 'src/index.ts',
      replacements: [{ oldText: 'export const ok = false;', newText: 'export const ok = true;' }],
    },
    { kind: 'delete', filePath: 'old.txt' },
    { kind: 'command', command: 'npm test', cwd: '.' },
  ]);
});

test('extractFileActions hides internal tags and approval boilerplate', () => {
  const parsed = extractFileActions(`<rakit_patch path="index.html">
<<<<<<< SEARCH
A
=======
B
>>>>>>> REPLACE
</rakit_patch>
Silakan approve dulu, nanti perubahan akan diterapkan.
Selesai disiapkan.`);

  assert.equal(parsed.displayText, 'Selesai disiapkan.');
  assert.equal(parsed.actions.length, 1);
});

test('safe path blocks traversal outside project', async () => {
  await withTempCwd(async () => {
    await assert.rejects(() => writeTextFile('../outside.txt', 'bad'), /keluar dari folder project/);
    await assert.rejects(() => readTextFile('../outside.txt'), /keluar dari folder project/);
  });
});

test('write/read text file inside project works', async () => {
  await withTempCwd(async () => {
    await writeTextFile('src/ok.txt', 'hello');
    assert.equal(await readTextFile('src/ok.txt'), 'hello');
  });
});

test('project tree lists files and ignores node_modules', async () => {
  await withTempCwd(async () => {
    await writeTextFile('src/ok.txt', 'hello');
    await writeTextFile('node_modules/pkg/index.js', 'ignore');
    const tree = await listProjectTree('.');
    assert.match(tree, /src\//);
    assert.match(tree, /ok\.txt/);
    assert.doesNotMatch(tree, /node_modules/);
  });
});

test('inspectProject includes tree and important file content', async () => {
  await withTempCwd(async () => {
    await writeTextFile('index.html', '<h1>Hello</h1>');
    await writeTextFile('style.css', 'body { color: red; }');
    const inspect = await inspectProject('.');
    assert.match(inspect, /Inspect \./);
    assert.match(inspect, /index\.html/);
    assert.match(inspect, /<h1>Hello<\/h1>/);
  });
});

test('findProjectFiles returns full nested paths and content hints', async () => {
  await withTempCwd(async () => {
    await writeTextFile('Desktop/login-page/index.html', '<title>Login Page</title>');
    await writeTextFile('Desktop/login-page/script.js', 'console.log("auth login")');
    const result = await findProjectFiles('login page');
    assert.match(result, /Desktop\/login-page\/index\.html/);
    assert.match(result, /Desktop\/login-page\/script\.js/);
  });
});

test('buildPromptFileContext includes relevant file content automatically', async () => {
  await withTempCwd(async () => {
    await writeTextFile('login-page/index.html', '<h1>Masuk Akun</h1>');
    const context = await buildPromptFileContext('edit login page menjadi warung kopi');
    assert.ok(context);
    assert.match(context, /login-page\/index\.html/);
    assert.match(context, /<h1>Masuk Akun<\/h1>/);
  });
});

test('patch action treats already-applied replacement as no-op', async () => {
  await withTempCwd(async () => {
    await writeTextFile('index.html', '<title>Baru</title>');
    const result = await applyFileAction({
      kind: 'patch',
      filePath: 'index.html',
      replacements: [{ oldText: '<title>Lama</title>', newText: '<title>Baru</title>' }],
    });
    assert.match(result, /file dipatch/);
    assert.equal(await readTextFile('index.html'), '<title>Baru</title>');
  });
});

test('applyFileActions preflights merged patches before writing', async () => {
  await withTempCwd(async () => {
    await writeTextFile('index.html', '<title>Lama</title>\n<h1>Lama</h1>');
    await assert.rejects(() => applyFileActions([
      {
        kind: 'patch',
        filePath: 'index.html',
        replacements: [{ oldText: '<title>Lama</title>', newText: '<title>Baru</title>' }],
      },
      {
        kind: 'patch',
        filePath: 'index.html',
        replacements: [{ oldText: '<p>Tidak ada</p>', newText: '<p>Baru</p>' }],
      },
    ]), /SEARCH tidak ditemukan/);
    assert.equal(await readTextFile('index.html'), '<title>Lama</title>\n<h1>Lama</h1>');
  });
});
