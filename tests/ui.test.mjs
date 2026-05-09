import test from 'node:test';
import assert from 'node:assert/strict';
import { isPinnedFooterSupported } from '../dist/ui.js';

test('footer support helper returns boolean', () => {
  assert.equal(typeof isPinnedFooterSupported(), 'boolean');
});
