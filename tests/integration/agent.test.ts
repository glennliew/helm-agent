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
  try {
    const s = mock();
    assert.equal(s.availableTools().some((x) => x.pluginId === 'helm.files'), false, 'the model is not offered the tool');
    // A model that still calls it (remembering an earlier turn) gets an explanation, and nothing runs.
    const { ends } = await run(s, 'call files__read_file {"path":"notes.txt"}');
    assert.equal(ends[0]!.ok, false);
    assert.equal(ends[0]!.error?.code, 'TOOL_UNAVAILABLE');
    assert.match(ends[0]!.error!.message, /disabled/);
    assert.match(ends[0]!.error!.hint ?? '', /helm plugin enable helm\.files/);
  } finally {
    await t.helm.enable('helm.files');
  }
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

test('watch hooks see conversation content only with conversation.read', async () => {
  const w = makeHelm();
  try {
    await install(w.helm, 'helm.mock-model');
    await install(w.helm, path.join(FIXTURES, 'watcher'), { link: true, deny: ['conversation.read'] });
    const seen = async () => {
      await new Promise((r) => setTimeout(r, 150)); // watch hooks are fire-and-forget
      const entry = w.helm.contributions().tools.find((x) => x.pluginId === 'test.watcher')!;
      return JSON.parse((await w.helm.invokeTool(entry, {})).content.map((b: any) => b.text).join('')) as Array<{ event: string; payload: any }>;
    };
    const s = new Session(w.helm, { provider: 'helm.mock-model/mock' });
    await run(s, 'my private plan');
    await run(s, 'call watcher__seen');
    let log = await seen();
    const msgHook = w.helm.contributions().hooks.find((h) => h.pluginId === 'test.watcher' && h.hook.event === 'message.user')!;
    assert.equal(msgHook.available, false, 'message hooks need conversation.read');
    assert.match(msgHook.reason ?? '', /conversation\.read/);
    assert.ok(!log.some((e) => e.event === 'message.user'));
    assert.ok(!JSON.stringify(log).includes('my private plan'));
    const after = log.find((e) => e.event === 'tool.after')!;
    assert.ok(after, 'tool.after watch hooks fire');
    assert.deepEqual(after.payload.redacted, ['input', 'output']);
    assert.equal(after.payload.exposedName, 'watcher__seen', 'metadata is still delivered');

    await w.helm.disable('helm.mock-model');
    log = await seen();
    assert.ok(log.some((e) => e.event === 'plugin.state' && e.payload.plugin === 'helm.mock-model' && e.payload.to === 'disabled'), 'plugin.state reaches running watchers');
    assert.ok(!log.some((e) => e.event === 'plugin.state' && e.payload.plugin === 'test.watcher'), 'a plugin is not told about its own state');
    await w.helm.enable('helm.mock-model');

    await w.helm.grant('test.watcher', 'conversation.read');
    await run(new Session(w.helm, { provider: 'helm.mock-model/mock' }), 'now you may read this');
    log = await seen();
    assert.ok(log.some((e) => e.event === 'message.user' && e.payload.text === 'now you may read this'));
  } finally { await w.cleanup(); }
});

test('a tool the model remembers but whose plugin lost a required permission is explained, not "unknown"', async () => {
  await t.helm.revoke('helm.files', 'fs.read');
  try {
    const { ends } = await run(mock(), 'call files__read_file {"path":"notes.txt"}');
    assert.equal(ends[0]!.ok, false);
    assert.equal(ends[0]!.plugin, 'helm.files');
    assert.equal(ends[0]!.error?.code, 'TOOL_UNAVAILABLE');
    assert.match(ends[0]!.error!.message, /Files \(helm\.files\) is installed.*missing required permission\(s\): fs\.read/);
    assert.match(ends[0]!.error!.hint ?? '', /helm plugin grant helm\.files/);
    const unknown = await run(mock(), 'call nothing__here {}');
    assert.equal(unknown.ends[0]!.error?.code, 'NOT_IMPLEMENTED');
  } finally {
    await t.helm.grant('helm.files', 'fs.read');
  }
  const again = await run(mock(), 'call files__read_file {"path":"notes.txt"}');
  assert.equal(again.ends[0]!.ok, true);
});

test('when a tool offered earlier in the conversation becomes unavailable, the user is warned once and the model is told why', async () => {
  const s = mock();
  const first = await run(s, 'call files__read_file {"path":"notes.txt"}');
  assert.equal(first.ends[0]!.ok, true);
  assert.equal(s.toolChanges().gone.length, 0);
  await t.helm.revoke('helm.files', 'fs.read');
  try {
    const changes = s.toolChanges();
    assert.ok(changes.gone.some((g) => g.exposedName === 'files__read_file' && /fs\.read/.test(g.reason)));
    assert.match(changes.note ?? '', /were real/);
    const second = await run(s, 'hello again');
    const warnings = second.events.filter((e: any) => e.type === 'warning').map((e: any) => e.message);
    assert.equal(warnings.length, 1, 'one notice per plugin, not per tool');
    assert.match(warnings[0], /^Files, helm\.files: .*read_file.* are no longer available \(missing required permission\(s\): fs\.read\)\.$/);
    const third = await run(s, 'and again');
    assert.equal(third.events.filter((e: any) => e.type === 'warning' && /read_file/.test(e.message)).length, 0, 'announced only once');
    // The change is written into the conversation where it happened, marked as a Helm note.
    const noted = s.messages.find((m) => m.role === 'user' && m.content.startsWith('hello again'));
    assert.match(noted?.content ?? '', /\[Helm note: The tools .*files__read_file.* \(Files, helm\.files\) became unavailable at this point: missing required permission\(s\): fs\.read\. Results they returned earlier were real\.\]/);
  } finally {
    await t.helm.grant('helm.files', 'fs.read');
  }
  assert.equal(s.toolChanges().gone.length, 0, 'restored tools drop out of the note');
  const fourth = await run(s, 'it is back');
  assert.ok(fourth.events.some((e: any) => e.type === 'warning' && /read_file.* are available again/.test(e.message)));
  const back = s.messages.find((m) => m.role === 'user' && m.content.startsWith('it is back'));
  assert.match(back?.content ?? '', /available again: the user restored them\. They really were unavailable before this point\./);
  const fifth = await run(s, 'quiet now');
  assert.equal(fifth.events.filter((e: any) => e.type === 'warning').length, 0);
});
