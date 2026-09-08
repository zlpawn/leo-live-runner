import test from 'node:test';
import assert from 'node:assert/strict';
import { runPythonCode } from '../scripts/common/xlsx.js';

test('runPythonCode should fall back when the preferred Python command is missing', () => {
  const child = runPythonCode('', ['leo-definitely-missing-python3', 'python3']);

  assert.equal(child.error, undefined);
  assert.ok(child.stdout.includes('error'));
});

test('runPythonCode should report all missing Python candidates', () => {
  const child = runPythonCode('', ['leo-definitely-missing-python3', 'leo-definitely-missing-python']);

  assert.ok(child.error);
  assert.match(child.error.message, /leo-definitely-missing-python3.*leo-definitely-missing-python/);
});
