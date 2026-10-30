// Run with: helm plugin test .
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, callTool, renderPanel, resultText } from '@helm-agent/plugin-sdk/testing';
import plugin, { parseUnittest } from '../src/index.ts';

const FAILING = `test_eta_with_a_fair_tide (tests.test_passage.PassageTest) ... FAIL
test_zero (tests.test_units.UnitsTest) ... ok

======================================================================
FAIL: test_eta_with_a_fair_tide (tests.test_passage.PassageTest)
----------------------------------------------------------------------
AssertionError: 3.3333333333333335 != 2.0 within 7 places

----------------------------------------------------------------------
Ran 2 tests in 0.001s

FAILED (failures=1)
`;
const PASSING_311 = `test_zero (tests.test_units.UnitsTest.test_zero) ... ok
test_describe (tests.test_passage.PassageTest.test_describe)
Docstrings move the result to the next line. ... ok

----------------------------------------------------------------------
Ran 2 tests in 0.002s

OK
`;
const config = { startDir: '.', timeoutSeconds: 60 };
const grants = [{ id: 'process.exec', scope: ['python3'] }, { id: 'fs.read', scope: ['${workspace}'] }];

test('parses failures from Python 3.10 output', () => {
  const r = parseUnittest(FAILING);
  assert.equal(r.ok, false);
  assert.equal(r.ran, 2);
  assert.equal(r.failed, 1);
  assert.deepEqual(r.cases.map((c) => c.status), ['FAIL', 'ok']);
  assert.match(r.details, /3\.3333333333333335 != 2\.0/);
});

test('parses Python 3.11+ names and docstring lines', () => {
  const r = parseUnittest(PASSING_311);
  assert.equal(r.ok, true);
  assert.deepEqual(r.cases.map((c) => `${c.where}.${c.name}`), ['tests.test_units.UnitsTest.test_zero', 'tests.test_passage.PassageTest.test_describe']);
});

test('run_tests asks the host to run python3 and reports failures to the model', async () => {
  const calls: string[][] = [];
  const ctx = createTestContext({ config, grants, exec: (cmd, args) => { calls.push([cmd, ...args]); return { code: 1, stderr: FAILING }; } });
  const text = resultText(await callTool(plugin, 'run_tests', { pattern: 'PassageTest' }, ctx));
  assert.deepEqual(calls[0]!.slice(0, 4), ['python3', '-m', 'unittest', 'discover']);
  assert.deepEqual(calls[0]!.slice(-2), ['-k', 'PassageTest']);
  assert.match(text, /1 passed, 1 failed/);
  assert.match(text, /✗ tests\.test_passage\.PassageTest\.test_eta_with_a_fair_tide \(FAIL\)/);
  // The panel shows the stored result.
  assert.match(JSON.stringify(await renderPanel(plugin, 'tests', ctx)), /failing/);
});

test('without a process.exec grant for python3 the call is refused', async () => {
  const ctx = createTestContext({ config, grants: [{ id: 'process.exec', scope: ['git'] }], exec: () => ({ code: 0 }) });
  await assert.rejects(callTool(plugin, 'run_tests', {}, ctx), /PERMISSION_DENIED|needs process\.exec/);
});
