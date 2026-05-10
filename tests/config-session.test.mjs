import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getDefaultConfig,
  getDefaultModelForProvider,
  redactConfig,
} from '../dist/config.js';
import {
  clearProjectSession,
  getProjectSessionPath,
  getProjectSessionSummary,
  loadProjectSession,
  saveProjectSession,
} from '../dist/session.js';

test('default config uses OpenRouter provider and model', () => {
  const config = getDefaultConfig();

  assert.equal(config.provider, 'openrouter');
  assert.equal(config.model, getDefaultModelForProvider('openrouter'));
  assert.equal(config.theme, 'rich');
});

test('provider default models are provider-specific', () => {
  assert.equal(getDefaultModelForProvider('openrouter'), 'meta-llama/llama-3.1-8b-instruct:free');
  assert.equal(getDefaultModelForProvider('openai-codex'), 'gpt-5.1-codex-mini');
  assert.equal(getDefaultModelForProvider('anthropic'), 'claude-opus-4-7');
  assert.equal(getDefaultModelForProvider('gemini'), 'gemini-2.5-pro');
  assert.equal(getDefaultModelForProvider('groq'), 'llama-3.3-70b-versatile');
  assert.equal(getDefaultModelForProvider('ollama'), 'llama3.2');
});

test('redactConfig masks API keys and hides key for Codex', () => {
  for (const provider of ['openrouter', 'anthropic', 'gemini', 'groq', 'ollama']) {
    assert.equal(redactConfig({
      provider,
      apiKey: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz',
      model: 'model-a',
      systemPrompt: 'prompt',
      temperature: 0.7,
      theme: 'rich',
    }).apiKey, 'sk-or-v...wxyz');
  }

  assert.equal(redactConfig({
    provider: 'openai-codex',
    apiKey: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz',
    model: 'model-b',
    systemPrompt: 'prompt',
    temperature: 0.7,
    theme: 'rich',
  }).apiKey, '(tidak dipakai untuk provider ini)');
});

test('project session path is stable per resolved project path', () => {
  const projectPath = path.join(process.cwd(), 'example-project');

  assert.equal(getProjectSessionPath(projectPath), getProjectSessionPath(path.resolve(projectPath)));
  assert.match(getProjectSessionPath(projectPath), /sessions[/\\][a-f0-9]{16}\.json$/);
});

test('project session save, load, summarize, and clear lifecycle works', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'rakit-session-test-'));

  try {
    const config = {
      provider: 'anthropic',
      apiKey: 'sk-ant-test-placeholder',
      model: 'claude-opus-4-7',
      systemPrompt: 'system prompt',
      temperature: 0.7,
      theme: 'rich',
    };
    const messages = [
      { role: 'system', content: 'ignored system' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];

    const sessionPath = await saveProjectSession(messages, config, projectPath);
    assert.equal(sessionPath, getProjectSessionPath(projectPath));

    const session = await loadProjectSession(projectPath);
    assert.ok(session);
    assert.equal(session.projectPath, path.resolve(projectPath));
    assert.equal(session.provider, 'anthropic');
    assert.equal(session.model, 'claude-opus-4-7');
    assert.deepEqual(session.messages, messages.slice(1));

    const summary = await getProjectSessionSummary(projectPath);
    assert.equal(summary.exists, true);
    assert.equal(summary.path, sessionPath);
    assert.equal(summary.messageCount, 2);
    assert.equal(summary.model, 'claude-opus-4-7');
    assert.match(summary.updatedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);

    await clearProjectSession(projectPath);
    assert.equal(await loadProjectSession(projectPath), undefined);
    assert.deepEqual(await getProjectSessionSummary(projectPath), { path: sessionPath, exists: false });
  } finally {
    await fs.rm(projectPath, { recursive: true, force: true });
  }
});
