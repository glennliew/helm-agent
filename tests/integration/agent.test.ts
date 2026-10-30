import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Session } from '../../packages/core/src/agent/session.ts';
import type { ApprovalDecision, ApprovalRequest } from '../../packages/core/src/permissions/broker.ts';
import { makeHelm, install, run, fakeTransport, FIXTURES } from '../helpers.ts';
import type { TestHelm } from '../helpers.ts';

const FAKE_KEY = 'sk-or-v1-' + 'a'.repeat(48);
const LEAKED = 'sk-or-v1-' + 'b'.repeat(48);
let decision: ApprovalDecision = 'deny';
const approvals: ApprovalRequest[] = [];
let t: TestHelm;

before(async () => {
  t = makeHelm({
    files: { 'notes.txt': 'hello notes', '.env': `OPENROUTER_API_KEY=${FAKE_KEY}\n`, 'leak.txt': `the token is ${LEAKED}\n` },
    approver: { request: async (r) => { approvals.push(r); return decision; } },
  });
  for (const id of ['helm.mock-model', 'helm.files', 'helm.guard']) await install(t.helm, id);
});
after(() => t.cleanup());

const mock = () => new Session(t.helm, { provider: 'helm.mock-model/mock' });

test('with no plugins the host has no tools and no model: every capability comes from plugins', async () => {
  const bare = makeHelm();
  try {
    assert.equal(bare.helm.contributions().tools.length, 0);
    assert.equal(bare.helm.providers().length, 0);
    const r = await run(new Session(bare.helm), 'hi').catch((e) => ({ events: [{ type: 'error', error: e }] }));
    const err = r.events.find((e: any) => e.type === 'error') as any;
    assert.ok(err, 'no provider must be reported as an error');
    assert.match(`${err.error.message} ${err.error.hint ?? ''}`, /provider/i);
  } finally { await bare.cleanup(); }
});

test('the model calls a plugin tool and the result flows back into the conversation', async () => {
  const { reply, ends } = await run(mock(), 'call files__read_file {"path":"notes.txt"}');
  assert.equal(ends.length, 1);
  assert.equal(ends[0]!.ok, true);
  assert.equal(ends[0]!.plugin, 'helm.files');
  assert.match(reply, /hello notes/);
});

test('Guard (a plugin hook) blocks credential files before the Files plugin ever sees the call', async () => {
  const s = mock();
  const { reply, ends } = await run(s, 'call files__read_file {"path":".env"}');
  assert.equal(ends[0]!.blocked, true);
  assert.match(ends[0]!.summary + (ends[0]!.error?.message ?? ''), /helm\.guard|credential/i);
  assert.ok(!reply.includes(FAKE_KEY));
  const transcript = fs.readFileSync(path.join(t.helm.paths.sessions, `${s.id}.jsonl`), 'utf8');
  assert.ok(!transcript.includes(FAKE_KEY));
  assert.ok(t.helm.audit.query({ plugin: 'helm.guard' }).length > 0 || t.helm.audit.query({ denied: true }).length > 0);
});

test('Guard redacts credentials that appear in tool output', async () => {
  const { reply, ends } = await run(mock(), 'call files__read_file {"path":"leak.txt"}');
  assert.equal(ends[0]!.ok, true);
  assert.ok(!reply.includes(LEAKED), reply);
  assert.match(reply, /the token is/);
});

test('write tools need approval: deny leaves the disk untouched, allow writes', async () => {
  const target = path.join(t.workspace, 'out.txt');
  decision = 'deny';
  approvals.length = 0;
  const denied = await run(mock(), 'call files__write_file {"path":"out.txt","content":"x"}');
  assert.equal(denied.ends[0]!.ok, false);
  assert.equal(fs.existsSync(target), false);
  assert.equal(approvals[0]?.kind, 'tool');
  decision = 'allow';
  const allowed = await run(mock(), 'call files__write_file {"path":"out.txt","content":"x"}');
  assert.equal(allowed.ends[0]!.ok, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'x');
  decision = 'deny';
});

test('a crashing fail-closed hook blocks the call instead of letting it through', async () => {
  await install(t.helm, path.join(FIXTURES, 'bad-hook'), { link: true });
  const { ends } = await run(mock(), 'call files__read_file {"path":"notes.txt"}');
  assert.equal(ends[0]!.ok, false);
  assert.match(JSON.stringify(ends[0]), /bad-hook/);
  await t.helm.disable('test.bad-hook');
  const after = await run(mock(), 'call files__read_file {"path":"notes.txt"}');
  assert.equal(after.ends[0]!.ok, true);
});

test('disabling a plugin removes its tools from the agent', async () => {
  await t.helm.disable('helm.files');
  const s = mock();
  const { ends, reply } = await run(s, 'call files__read_file {"path":"notes.txt"}');
  assert.equal(ends.length, 0, 'the model was never offered the tool');
  assert.match(reply, /tools available: 0/);
  await t.helm.enable('helm.files');
});

// ---------------------------------------------------------------- OpenRouter provider (offline)
test('OpenRouter provider: tool calling round-trip, auth header, reasoning passthrough', async () => {
  let n = 0;
  const fake = fakeTransport([[
    '/chat/completions',
    () => (++n === 1
      ? { body: { model: 'anthropic/claude-opus-5.5', choices: [{ finish_reason: 'tool_calls', message: { content: null, reasoning_details: [{ type: 'reasoning.text', text: 'look at notes' }], tool_calls: [{ id: 'c1', type: 'function', function: { name: 'files__read_file', arguments: '{"path":"notes.txt"}' } }] } }], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 } } }
      : { body: { model: 'anthropic/claude-opus-5.5', choices: [{ finish_reason: 'stop', message: { content: 'The notes say hello.' } }], usage: { prompt_tokens: 150, completion_tokens: 8 } } }),
  ]]);
  const o = makeHelm({ files: { 'notes.txt': 'hello notes' }, netTransport: fake.transport });
  try {
    await install(o.helm, 'helm.openrouter');
    await install(o.helm, 'helm.files');
    o.helm.setSecret('helm.openrouter', 'API_KEY', FAKE_KEY);
    const s = new Session(o.helm, { provider: 'helm.openrouter/openrouter' });
    const { reply, ends } = await run(s, 'what do my notes say?');
    assert.equal(reply, 'The notes say hello.');
    assert.equal(ends[0]!.ok, true);
    assert.equal(fake.requests.length, 2);
    const [first, second] = fake.requests.map((r) => ({ ...r, json: JSON.parse(r.body!) }));
    assert.equal(first!.headers!.authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(first!.json.model, 'anthropic/claude-opus-5.5');
    assert.ok(first!.json.tools.some((x: any) => x.function.name === 'files__read_file'));
    const assistant = second!.json.messages.find((m: any) => m.role === 'assistant');
    assert.deepEqual(assistant.reasoning_details, [{ type: 'reasoning.text', text: 'look at notes' }]);
    assert.match(JSON.stringify(second!.json.messages.find((m: any) => m.role === 'tool')), /hello notes/);
    const transcript = fs.readFileSync(path.join(o.helm.paths.sessions, `${s.id}.jsonl`), 'utf8');
    assert.ok(!transcript.includes(FAKE_KEY), 'API key must never reach transcripts');

    // Blocked models are refused before any network call.
    const before = fake.requests.length;
    const blocked = await run(new Session(o.helm, { provider: 'helm.openrouter/openrouter', model: 'openai/gpt-6' }), 'hi').catch((e) => ({ error: e }));
    assert.match(String((blocked as any).error?.message ?? JSON.stringify((blocked as any).events)), /gpt>=6|blocked|policy/i);
    assert.equal(fake.requests.length, before);

    // Pointing the plugin at a host it was not granted fails in the broker, not at the network.
    await o.helm.setConfig('helm.openrouter', { baseUrl: 'https://api.evil.example/v1' });
    const exfil = await run(new Session(o.helm, { provider: 'helm.openrouter/openrouter' }), 'hi').catch((e) => ({ error: e }));
    assert.match(String((exfil as any).error?.message ?? JSON.stringify((exfil as any).events)), /does not allow host|api\.evil\.example/);
    assert.equal(fake.requests.length, before);
  } finally { await o.cleanup(); }
});
