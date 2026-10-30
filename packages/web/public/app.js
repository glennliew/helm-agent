import { h, render } from '/vendor/preact.mjs';
import { useState, useEffect, useRef, useCallback } from '/vendor/hooks.mjs';
import htm from '/vendor/htm.mjs';

const html = htm.bind(h);

// ---------------------------------------------------------------- token & API
// The token arrives in the URL fragment (never sent to servers or logged); keep it in this tab only.
const hashParams = new URLSearchParams(location.hash.slice(1));
const fromHash = hashParams.get('token');
if (fromHash) {
  sessionStorage.setItem('helm-token', fromHash);
  history.replaceState(null, '', location.pathname + '#/' + (hashParams.get('view') || 'chat'));
}
const parseRoute = () => { const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/'); return { name: name || 'chat', id: rest.length ? decodeURIComponent(rest.join('/')) : undefined }; };
const TOKEN = sessionStorage.getItem('helm-token') || '';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'x-helm-token': TOKEN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: { code: 'BAD_RESPONSE', message: `HTTP ${res.status}` } }));
  if (!res.ok || data?.error) throw data.error ?? { code: 'HTTP_' + res.status, message: res.statusText };
  return data;
}

// ---------------------------------------------------------------- event bus (SSE)
const listeners = new Set();
function connectEvents() {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN)}`);
  for (const type of ['hello', 'changed', 'session', 'approval', 'approval.resolved', 'plugin.state', 'plugin.notify', 'plugin.progress', 'panel.refresh']) {
    es.addEventListener(type, (e) => { const data = JSON.parse(e.data); listeners.forEach((fn) => fn(type, data)); });
  }
  es.onerror = () => listeners.forEach((fn) => fn('disconnected', {}));
  return es;
}
function useEvents(fn, deps = []) {
  useEffect(() => { listeners.add(fn); return () => listeners.delete(fn); }, deps);
}

// ---------------------------------------------------------------- toasts
let pushToast = () => {};
function Toasts() {
  const [items, setItems] = useState([]);
  pushToast = useCallback((t) => {
    const id = Math.random();
    setItems((xs) => [...xs, { id, ...t }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.kind === 'error' ? 9000 : 4500);
  }, []);
  return html`<div class="toasts">${items.map((t) => html`<div class=${'toast ' + (t.kind || '')}><div>${t.text}</div>${t.hint && html`<div class="hint">${t.hint}</div>`}</div>`)}</div>`;
}
const toastError = (e) => pushToast({ kind: 'error', text: e.message || String(e), hint: e.hint });

// ---------------------------------------------------------------- shared bits
function Badge({ tone, children }) { return html`<span class=${'badge ' + (tone || '')}>${children}</span>`; }

function statusBadge(p) {
  const a = p.availability;
  if (a.available) return html`<${Badge} tone="ok">ready<//>`;
  if (a.code === 'PLUGIN_DISABLED') return html`<${Badge} tone="muted">disabled<//>`;
  if (a.code === 'PLUGIN_QUARANTINED') return html`<${Badge} tone="bad">quarantined<//>`;
  return html`<${Badge} tone="warn">unavailable<//>`;
}
function isoBadge(iso, trusted) {
  if (!iso) return null;
  return iso.level === 'strict' ? html`<${Badge} tone="ok">strict sandbox<//>` : html`<${Badge} tone="warn">${iso.level} isolation${trusted ? ' · trusted' : ''}<//>`;
}
const riskTone = (r) => (r === 'high' ? 'bad' : r === 'medium' ? 'warn' : 'ok');

function ErrorBox({ error }) {
  if (!error) return null;
  return html`<div class="err"><b>${error.message}</b> <span class="small mono">[${error.code}]</span>${error.hint && html`<div class="hint">→ ${error.hint}</div>`}</div>`;
}

function useAsync(fn, deps) {
  const [state, set] = useState({ loading: true });
  const run = useCallback(() => { fn().then((data) => set({ data }), (error) => set({ error })); }, deps);
  useEffect(run, [run]);
  return [state, run];
}

// Safe, tiny Markdown: escape first, then a few constructs. No raw HTML from models or plugins.
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function md(src) {
  const blocks = [];
  let s = esc(src).replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _l, code) => { blocks.push(`<pre><code>${code}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/^#{1,4} (.+)$/gm, '<b>$1</b>');
  const out = [];
  let list = null;
  for (const line of s.split('\n')) {
    const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) { if (!list) { list = []; } list.push(`<li>${li[1]}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    out.push(line.trim() ? `<p>${line}</p>` : '');
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
}
function Markdown({ text }) { return html`<div dangerouslySetInnerHTML=${{ __html: md(text) }} />`; }

// Plugin-declared UI → DOM. Only these node types exist; plugins can't inject markup or scripts.
function UINode({ node, onCommand }) {
  if (!node) return null;
  switch (node.type) {
    case 'stack': return html`<div class="ui-stack">${node.children.map((c) => html`<${UINode} node=${c} onCommand=${onCommand} />`)}</div>`;
    case 'heading': return html`<div class="panel-title">${node.text}</div>`;
    case 'text': return html`<div class=${node.tone === 'muted' ? 'muted small' : node.tone ? 'badge ' + node.tone : ''}>${node.text}</div>`;
    case 'markdown': return html`<${Markdown} text=${node.text} />`;
    case 'keyValue': return html`<dl class="kv small">${node.items.map((i) => html`<dt>${i.key}</dt><dd>${i.value}</dd>`)}</dl>`;
    case 'table': return html`<table class="t small"><thead><tr>${node.columns.map((c) => html`<th>${c}</th>`)}</tr></thead><tbody>${node.rows.map((r) => html`<tr>${r.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody></table>`;
    case 'list': return html`<ul class="small">${node.items.map((i) => html`<li>${i}</li>`)}</ul>`;
    case 'badge': return html`<div><${Badge} tone=${node.tone}>${node.text}<//></div>`;
    case 'button': return html`<div><button class="btn sm" onClick=${() => onCommand?.(node.command, node.args)}>${node.label}</button></div>`;
    default: return null;
  }
}

// ---------------------------------------------------------------- approvals (global)
function Approvals({ initial }) {
  const [items, setItems] = useState(initial || []);
  useEvents((type, data) => {
    if (type === 'approval') setItems((xs) => [...xs, data]);
    if (type === 'approval.resolved') setItems((xs) => xs.filter((x) => x.id !== data.id));
  }, []);
  const a = items[0];
  if (!a) return null;
  const answer = (decision) => api(`/api/approvals/${a.id}`, { method: 'POST', body: { decision } }).catch(toastError);
  return html`<div class="overlay"><div class="modal approval">
    <div class="small muted">Approval needed · ${a.plugin}${items.length > 1 ? ` · ${items.length - 1} more waiting` : ''}</div>
    <h2>${a.title}</h2>
    <pre class="log">${a.detail}</pre>
    <div class="actions">
      <button class="btn danger" onClick=${() => answer('deny')}>Deny</button>
      ${a.kind === 'tool' && html`<button class="btn" onClick=${() => answer('always')}>Allow for this session</button>`}
      <button class="btn primary" onClick=${() => answer('allow')}>Allow once</button>
    </div>
  </div></div>`;
}

// ---------------------------------------------------------------- consent (install / update)
function Consent({ plan, onDone, onCancel }) {
  const [dec, setDec] = useState(() => Object.fromEntries(plan.consent.map((c) => [c.id, { granted: true, scope: (c.scope || []).join(', '), mode: 'allow' }])));
  const [busy, setBusy] = useState(false);
  const missingRequired = plan.consent.filter((c) => !c.optional && !dec[c.id].granted);
  const commit = async () => {
    setBusy(true);
    try {
      const decisions = plan.consent.map((c) => ({ id: c.id, granted: dec[c.id].granted, mode: dec[c.id].mode, scope: c.scope ? dec[c.id].scope.split(',').map((s) => s.trim()).filter(Boolean) : undefined }));
      const res = await api(`/api/plans/${plan.planId}/commit`, { method: 'POST', body: { decisions } });
      (res.notes || []).forEach((n) => pushToast({ kind: 'warn', text: n }));
      pushToast({ text: `${plan.isUpdate ? 'Updated' : 'Installed'} ${res.plugin.id} ${res.plugin.version}` });
      onDone(res.plugin);
    } catch (e) { toastError(e); setBusy(false); }
  };
  const cancel = () => { api(`/api/plans/${plan.planId}/cancel`, { method: 'POST', body: {} }).catch(() => {}); onCancel(); };
  const m = plan.manifest;
  const contrib = m.contributes || {};
  const adds = [['tools', (contrib.tools || []).map((t) => t.name)], ['commands', (contrib.commands || []).map((c) => c.name)], ['hooks', (contrib.hooks || []).map((x) => `${x.event} (${x.mode})`)], ['panels', (contrib.panels || []).map((p) => p.title)], ['model providers', (contrib.providers || []).map((p) => p.title)]].filter(([, v]) => v.length);
  return html`<div class="overlay"><div class="modal">
    <div class="spread"><div><h2 style="margin-bottom:2px">${plan.isUpdate ? `Update ${m.name} ${plan.from} → ${m.version}` : `Install ${m.name}`}</h2><div class="mono small muted">${m.id}@${m.version} · ${m.runtime}${m.publisher ? ' · by ' + m.publisher : ''}</div></div>${isoBadge(plan.isolation)}</div>
    <p>${m.description}</p>
    ${adds.length > 0 && html`<dl class="kv small">${adds.map(([k, v]) => html`<dt>adds ${k}</dt><dd>${v.join(', ')}</dd>`)}</dl>`}
    ${plan.isolation.level !== 'strict' && html`<div class="notice" style="margin-top:10px">Full sandbox isolation is unavailable here (${plan.isolation.reason}). The plugin will refuse to run until you start Helm from a normal terminal or explicitly trust it.</div>`}
    <h3>${plan.isUpdate ? (plan.consent.length ? 'New or wider permissions in this version' : 'No new permissions') : plan.consent.length ? 'Permissions requested' : 'No permissions requested'}</h3>
    ${plan.consent.map((c) => html`<div class=${'perm ' + (dec[c.id].granted ? 'granted' : 'denied')}>
      <div class="spread">
        <label class="switch"><input type="checkbox" checked=${dec[c.id].granted} onChange=${(e) => setDec({ ...dec, [c.id]: { ...dec[c.id], granted: e.target.checked } })} /><span class="name">${c.id}</span></label>
        <div class="row"><${Badge} tone=${riskTone(c.risk)}>${c.risk} risk<//>${c.optional ? html`<${Badge}>optional<//>` : html`<${Badge} tone="info">required<//>`}${c.change && html`<${Badge} tone="warn">${c.change === 'new' ? 'new' : 'wider'}<//>`}</div>
      </div>
      <div style="margin-top:6px">${c.description}</div>
      <div class="why">Why: ${c.reason}</div>
      ${c.scope && dec[c.id].granted && html`<div class="row" style="margin-top:8px"><span class="small muted">scope</span><input type="text" value=${dec[c.id].scope} onInput=${(e) => setDec({ ...dec, [c.id]: { ...dec[c.id], scope: e.target.value } })} style="flex:1" /></div>`}
      ${dec[c.id].granted && html`<label class="switch small" style="margin-top:6px"><input type="checkbox" checked=${dec[c.id].mode === 'ask'} onChange=${(e) => setDec({ ...dec, [c.id]: { ...dec[c.id], mode: e.target.checked ? 'ask' : 'allow' } })} /> ask me each time it is used</label>`}
    </div>`)}
    ${missingRequired.length > 0 && html`<div class="notice">Without ${missingRequired.map((c) => c.id).join(', ')} the plugin will be installed but stay disabled.</div>`}
    <div class="actions"><button class="btn" onClick=${cancel}>Cancel</button><button class="btn primary" disabled=${busy} onClick=${commit}>${plan.isUpdate ? 'Update' : 'Install'}</button></div>
  </div></div>`;
}

// ---------------------------------------------------------------- chat
function ToolCard({ ev }) {
  const end = ev.end;
  const cls = !end ? '' : end.blocked ? 'blocked' : end.ok ? '' : 'failed';
  return html`<div class=${'tool ' + cls}>
    <div class="spread"><div><span class="tname">${ev.tool}</span> <span class="muted small">via ${ev.plugin}</span></div>
      <div>${!end ? html`<${Badge} tone="info">running<//>` : end.blocked ? html`<${Badge} tone="warn">blocked<//>` : end.ok ? html`<${Badge} tone="ok">${end.durationMs} ms<//>` : html`<${Badge} tone="bad">${end.error?.code || 'failed'}<//>`}</div></div>
    ${end && !end.ok && html`<div style="margin-top:4px">${end.summary}${end.error?.hint && html`<div class="small muted">→ ${end.error.hint}</div>`}</div>`}
    <details><summary>input${end?.ok ? ' & result' : ''}</summary><pre class="mono">${JSON.stringify(ev.input, null, 2)}</pre>${end?.ok && html`<pre class="mono muted">${end.summary}</pre>`}</details>
  </div>`;
}

function Panels() {
  const [panels, setPanels] = useState([]);
  const [content, setContent] = useState({});
  const load = useCallback(async () => {
    try {
      const list = (await api('/api/panels')).filter((p) => p.available);
      setPanels(list);
      const entries = await Promise.all(list.map((p) => api(`/api/panels/${p.plugin}/${p.id}`).then((r) => [p.qualified, { ui: r.ui }], (e) => [p.qualified, { error: e }])));
      setContent(Object.fromEntries(entries));
    } catch (e) { /* shown elsewhere */ }
  }, []);
  useEffect(() => { load(); }, [load]);
  const timer = useRef();
  useEvents((type) => {
    if (type === 'panel.refresh' || type === 'changed' || (type === 'session')) { clearTimeout(timer.current); timer.current = setTimeout(load, 400); }
  }, [load]);
  const run = (plugin) => (command, args) => api('/api/commands/run', { method: 'POST', body: { plugin, command, args } }).then(load, toastError);
  return html`<aside class="panels">
    <div class="spread"><b>Plugin panels</b><button class="btn ghost sm" onClick=${load}>refresh</button></div>
    ${panels.length === 0 && html`<div class="muted small">No plugin contributes a panel yet. Panels are declared in a plugin's manifest and rendered here.</div>`}
    ${panels.map((p) => html`<div class="card"><div class="spread" style="margin-bottom:8px"><span class="panel-title">${p.title}</span><span class="small muted mono">${p.plugin}</span></div>
      ${content[p.qualified]?.error ? html`<${ErrorBox} error=${content[p.qualified].error} />` : html`<${UINode} node=${content[p.qualified]?.ui} onCommand=${run(p.plugin)} />`}</div>`)}
  </aside>`;
}

function Chat({ overview }) {
  const [sessionId, setSessionId] = useState(() => sessionStorage.getItem('helm-session'));
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [text, setText] = useState('');
  const logRef = useRef();
  const provider = overview?.provider;

  const ensureSession = async () => {
    if (sessionId) return sessionId;
    const { id } = await api('/api/sessions', { method: 'POST', body: {} });
    sessionStorage.setItem('helm-session', id);
    setSessionId(id);
    return id;
  };
  const apply = (list, ev) => {
    if (ev.type === 'tool.start') return [...list, { kind: 'tool', id: ev.id, tool: ev.tool, plugin: ev.plugin, input: ev.input }];
    if (ev.type === 'tool.end') return list.map((x) => (x.kind === 'tool' && x.id === ev.id ? { ...x, end: ev } : x)).concat(list.some((x) => x.kind === 'tool' && x.id === ev.id) ? [] : [{ kind: 'tool', id: ev.id, tool: ev.tool, plugin: ev.plugin, input: {}, end: ev }]);
    if (ev.type === 'user') return [...list, { kind: 'user', text: ev.text }];
    if (ev.type === 'assistant') return [...list, { kind: 'assistant', text: ev.text }];
    if (ev.type === 'error') return [...list, { kind: 'error', error: ev.error }];
    if (ev.type === 'warning') return [...list, { kind: 'warning', text: ev.message }];
    if (ev.type === 'model' && ev.usage) return [...list, { kind: 'usage', ev }];
    return list;
  };
  useEffect(() => {
    if (!sessionId) return;
    api(`/api/sessions/${sessionId}`).then((s) => { setItems(s.events.reduce(apply, [])); setBusy(s.busy); }, () => { sessionStorage.removeItem('helm-session'); setSessionId(null); });
  }, [sessionId]);
  useEvents((type, data) => {
    if (type !== 'session' || data.sessionId !== sessionId) return;
    const ev = data.event;
    if (ev.type === 'status') setStatus(ev.message);
    else if (ev.type === 'idle') { setBusy(false); setStatus(''); }
    else setItems((xs) => apply(xs, ev));
  }, [sessionId]);
  useEffect(() => { logRef.current && (logRef.current.scrollTop = logRef.current.scrollHeight); }, [items, status]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setText('');
    setBusy(true);
    setStatus('thinking');
    try { const id = await ensureSession(); await api(`/api/sessions/${id}/messages`, { method: 'POST', body: { text: t } }); } catch (e) { toastError(e); setBusy(false); setStatus(''); }
  };
  const newChat = () => { sessionStorage.removeItem('helm-session'); setSessionId(null); setItems([]); };
  const cancel = () => sessionId && api(`/api/sessions/${sessionId}/cancel`, { method: 'POST', body: {} });

  return html`<div class="chat">
    <div class="chat-main">
      <div class="chat-head spread">
        <div><b>Chat</b> <span class="muted small">${provider?.error ? '' : `${provider?.qualified ?? ''} · ${provider?.model ?? ''}`} · ${overview?.tools.ready ?? 0} tools ready</span></div>
        <div class="row"><button class="btn sm" onClick=${newChat}>New chat</button></div>
      </div>
      <div class="chat-log" ref=${logRef}>
        ${provider?.error && html`<${ErrorBox} error=${provider.error} />`}
        ${items.length === 0 && !provider?.error && html`<div class="empty">Ask Helm something. Everything it can do comes from your plugins:<br/><span class="small">try "What changed in this repo?", "Search the web for the Node.js permission model", or "Read .env" to see Guard step in.</span></div>`}
        ${items.map((it) => it.kind === 'user' ? html`<div class="msg user">${it.text}</div>`
          : it.kind === 'assistant' ? html`<div class="msg assistant"><${Markdown} text=${it.text} /></div>`
          : it.kind === 'tool' ? html`<${ToolCard} ev=${it} />`
          : it.kind === 'error' ? html`<${ErrorBox} error=${it.error} />`
          : it.kind === 'warning' ? html`<div class="notice small">${it.text}</div>`
          : it.kind === 'usage' ? html`<div class="small muted">${it.ev.model} · ${it.ev.usage.inputTokens ?? '?'} in / ${it.ev.usage.outputTokens ?? '?'} out${it.ev.usage.costUsd ? ` · $${it.ev.usage.costUsd.toFixed(4)}` : ''}</div>` : null)}
        ${busy && html`<div class="status-line">${status || 'working'}</div>`}
      </div>
      <div class="composer">
        <textarea rows="2" placeholder="Message Helm (Enter to send, Shift+Enter for a new line)" value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        ${busy ? html`<button class="btn" onClick=${cancel}>Stop</button>` : html`<button class="btn primary" onClick=${send}>Send</button>`}
      </div>
    </div>
    <${Panels} />
  </div>`;
}

// ---------------------------------------------------------------- plugins
function PluginList({ overview, go }) {
  const plugins = overview?.plugins ?? [];
  return html`<div class="page">
    <div class="spread"><div><h1>Plugins</h1><p class="sub">Every tool, provider, hook and panel in Helm comes from one of these. Each runs in its own sandboxed process.</p></div><button class="btn primary" onClick=${() => go('market')}>Add plugins</button></div>
    ${plugins.length === 0 && html`<div class="card empty">No plugins installed. Open <a href="#" onClick=${(e) => { e.preventDefault(); go('market'); }}>Marketplace</a> to add some.</div>`}
    <div class="grid">${plugins.map((p) => html`<div class="card pcard" onClick=${() => go('plugin', p.id)}>
      <div class="spread"><div><div class="title">${p.name}</div><div class="id">${p.id}@${p.version} · ${p.runtime}</div></div>${statusBadge(p)}</div>
      <p>${p.description}</p>
      <div class="chips">${isoBadge(p.isolation, p.trusted)}${Object.entries(p.counts).filter(([, n]) => n).map(([k, n]) => html`<${Badge}>${n} ${n === 1 ? k.replace(/s$/, '') : k}<//>`)}${p.process?.state === 'active' && html`<${Badge} tone="info">running<//>`}</div>
      ${!p.availability.available && p.availability.code !== 'PLUGIN_DISABLED' && html`<div class="small" style="margin-top:8px;color:var(--warn)">${p.availability.reason}</div>`}
    </div>`)}</div>
  </div>`;
}

function ConfigForm({ plugin, onSaved }) {
  const [values, setValues] = useState(() => Object.fromEntries(plugin.config.map((f) => [f.key, f.value])));
  const [error, setError] = useState();
  useEffect(() => setValues(Object.fromEntries(plugin.config.map((f) => [f.key, f.value]))), [plugin]);
  if (!plugin.config.length) return html`<div class="muted">This plugin has no settings.</div>`;
  const save = async () => {
    setError(undefined);
    const out = {};
    for (const f of plugin.config) {
      const v = values[f.key];
      if (JSON.stringify(v) !== JSON.stringify(f.default)) out[f.key] = v;
    }
    try { onSaved(await api(`/api/plugins/${plugin.id}/config`, { method: 'PUT', body: { values: out } })); pushToast({ text: 'Settings saved — the plugin was notified' }); } catch (e) { setError(e); }
  };
  const field = (f) => {
    const v = values[f.key];
    const set = (x) => setValues({ ...values, [f.key]: x });
    if (f.enum) return html`<select value=${v} onChange=${(e) => set(e.target.value)}>${f.enum.map((o) => html`<option value=${o}>${o}</option>`)}</select>`;
    if (f.type === 'boolean') return html`<label class="switch"><input type="checkbox" checked=${!!v} onChange=${(e) => set(e.target.checked)} /> ${v ? 'on' : 'off'}</label>`;
    if (f.type === 'integer' || f.type === 'number') return html`<input type="number" value=${v ?? ''} onInput=${(e) => set(e.target.value === '' ? undefined : Number(e.target.value))} />`;
    if (f.type === 'string') return html`<input type="text" value=${v ?? ''} onInput=${(e) => set(e.target.value)} />`;
    if (f.type === 'array' && (v ?? []).every((x) => typeof x === 'string')) return html`<textarea rows=${Math.min(8, Math.max(2, (v ?? []).length + 1))} value=${(v ?? []).join('\n')} onInput=${(e) => set(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))} />`;
    return html`<textarea rows="8" value=${JSON.stringify(v, null, 2)} onInput=${(e) => { try { set(JSON.parse(e.target.value)); } catch { /* keep typing */ } }} />`;
  };
  return html`<div>${plugin.config.map((f) => html`<label class="field"><span>${f.key} ${!values[f.key] === undefined ? '' : ''}<span class="muted small mono"> ${f.type}${f.isSet ? '' : ' · default'}</span></span>${field(f)}${f.description && html`<small>${f.description}</small>`}</label>`)}
    <${ErrorBox} error=${error} />
    <div class="row" style="margin-top:8px"><button class="btn primary" onClick=${save}>Save settings</button></div></div>`;
}

function Permissions({ plugin, onChange }) {
  const [scopeEdit, setScopeEdit] = useState({});
  const act = (path, body) => api(`/api/plugins/${plugin.id}/${path}`, { method: 'POST', body }).then((p) => { onChange(p); pushToast({ text: `${body.permission} ${path === 'grant' ? 'granted' : 'revoked'} — plugin restarted with the new sandbox` }); }, toastError);
  if (!plugin.permissions.length) return html`<div class="muted">This plugin requests no permissions. It can only compute and talk to Helm.</div>`;
  return html`<div>${plugin.permissions.map((p) => html`<div class=${'perm ' + (p.granted ? 'granted' : 'denied')}>
    <div class="spread"><div class="row"><span class="name">${p.id}</span><${Badge} tone=${riskTone(p.risk)}>${p.risk}<//>${p.optional ? html`<${Badge}>optional<//>` : html`<${Badge} tone="info">required<//>`}${p.granted ? html`<${Badge} tone="ok">granted${p.granted.mode === 'ask' ? ' · ask' : ''}<//>` : html`<${Badge} tone="muted">${p.declined ? 'declined' : 'not granted'}<//>`}</div>
      <div class="row">${p.granted ? html`<button class="btn sm danger" onClick=${() => act('revoke', { permission: p.id })}>Revoke</button>` : html`<button class="btn sm" onClick=${() => act('grant', { permission: p.id })}>Grant</button>`}</div></div>
    <div style="margin-top:6px">${p.description}</div>
    <div class="why">Why: ${p.reason}</div>
    <div class="small muted" style="margin-top:4px">Requested: ${(p.requested || ['—']).join(', ')}${p.granted?.scope ? ` · Granted: ${p.granted.scope.join(', ')}` : ''} · Enforced by: ${p.enforcedBy}</div>
    ${p.granted && p.requested && html`<div class="row" style="margin-top:8px">
      <input type="text" placeholder=${p.userExtensible ? 'add scope (e.g. api.example.com)' : 'narrow scope (comma-separated)'} value=${scopeEdit[p.id] || ''} onInput=${(e) => setScopeEdit({ ...scopeEdit, [p.id]: e.target.value })} style="flex:1" />
      <button class="btn sm" onClick=${() => act('grant', { permission: p.id, scope: (scopeEdit[p.id] || '').split(',').map((s) => s.trim()).filter(Boolean) })}>Add scope</button>
      ${p.granted.scope?.length > 1 && html`<button class="btn sm danger" onClick=${() => act('revoke', { permission: p.id, scope: (scopeEdit[p.id] || '').split(',').map((s) => s.trim()).filter(Boolean) })}>Remove scope</button>`}
    </div>`}
  </div>`)}</div>`;
}

function Secrets({ plugin, onChange }) {
  const [vals, setVals] = useState({});
  if (!plugin.secrets.length) return html`<div class="muted">This plugin declares no secrets.</div>`;
  const save = (name) => api(`/api/plugins/${plugin.id}/secrets`, { method: 'POST', body: { name, value: vals[name] } }).then((p) => { setVals({ ...vals, [name]: '' }); onChange(p); pushToast({ text: `${name} stored` }); }, toastError);
  const del = (name) => api(`/api/plugins/${plugin.id}/secrets/${name}`, { method: 'DELETE' }).then(onChange, toastError);
  return html`<div><p class="muted small">Secrets are stored by Helm (Keychain or an encrypted file), never in plugin folders. The plugin receives a value only when it asks, and only for names it declared. Values are redacted from logs.</p>
    ${plugin.secrets.map((s) => html`<div class="perm"><div class="spread"><span class="name">${s.name}</span>${s.stored ? html`<${Badge} tone="ok">stored<//>` : html`<${Badge} tone="warn">not set<//>`}</div>
      <div class="row" style="margin-top:8px"><input type="password" autocomplete="off" placeholder=${s.stored ? 'replace value' : 'paste value'} value=${vals[s.name] || ''} onInput=${(e) => setVals({ ...vals, [s.name]: e.target.value })} style="flex:1" /><button class="btn sm primary" disabled=${!vals[s.name]} onClick=${() => save(s.name)}>Save</button>${s.stored && html`<button class="btn sm danger" onClick=${() => del(s.name)}>Delete</button>`}</div></div>`)}</div>`;
}

function PluginDetail({ id, go, setPlan }) {
  const [state, reload] = useAsync(() => api(`/api/plugins/${id}`), [id]);
  const [tab, setTab] = useState('overview');
  const [p, setP] = useState();
  useEffect(() => { if (state.data) setP(state.data); }, [state.data]);
  useEvents((type, data) => { if ((type === 'changed' && (!data.plugin || data.plugin === id)) || (type === 'plugin.state' && data.plugin === id)) reload(); }, [id, reload]);
  if (state.error) return html`<div class="page"><${ErrorBox} error=${state.error} /></div>`;
  if (!p) return html`<div class="page muted">Loading…</div>`;
  const post = (action, body = {}) => api(`/api/plugins/${id}/${action}`, { method: 'POST', body }).then((r) => { if (r.id) setP(r); return r; }, (e) => { toastError(e); throw e; });
  const update = async () => { try { const plan = await api(`/api/plugins/${id}/update/prepare`, { method: 'POST', body: {} }); if (plan.upToDate) pushToast({ text: `${id} is up to date (${plan.version})` }); else setPlan(plan); } catch (e) { toastError(e); } };
  const uninstall = async () => { if (!confirm(`Uninstall ${p.name}? Its data is kept unless you choose purge later.`)) return; await post('uninstall', {}); go('plugins'); };
  const c = p.contributions;
  return html`<div class="page">
    <div class="row small"><a href="#" onClick=${(e) => { e.preventDefault(); go('plugins'); }}>Plugins</a> <span class="muted">/ ${p.id}</span></div>
    <div class="spread" style="margin-top:8px">
      <div><h1>${p.name} <span class="muted small mono">${p.version}</span></h1><p class="sub" style="margin:0">${p.description}</p></div>
      <div class="row">${statusBadge(p)}${isoBadge(p.isolation, p.trusted)}</div>
    </div>
    <div class="row" style="margin-top:14px">
      ${p.enabled ? html`<button class="btn" onClick=${() => post('disable')}>Disable</button>` : html`<button class="btn primary" onClick=${() => post('enable')}>Enable</button>`}
      ${(p.health.quarantinedAt || p.health.lastError) && html`<button class="btn" onClick=${() => post('reset')}>Reset health</button>`}
      ${p.isolation?.level !== 'strict' && (p.trusted ? html`<button class="btn" onClick=${() => post('untrust')}>Untrust</button>` : html`<button class="btn" onClick=${() => { if (confirm('Trusting lets this plugin run with reduced isolation when the macOS sandbox is unavailable. Continue?')) post('trust'); }}>Trust (reduced isolation)</button>`)}
      <button class="btn" onClick=${update}>Check for update</button>
      ${p.previous && html`<button class="btn" onClick=${() => post('rollback')}>Roll back to ${p.previous.version}</button>`}
      <button class="btn danger" onClick=${uninstall}>Uninstall</button>
    </div>
    ${!p.availability.available && p.availability.code !== 'PLUGIN_DISABLED' && html`<div class="notice" style="margin-top:14px"><b>Not runnable:</b> ${p.availability.reason}</div>`}
    ${p.health.lastError && html`<div class="err" style="margin-top:14px"><b>Last error</b> <span class="mono small">[${p.health.lastError.code}]</span> ${new Date(p.health.lastError.at).toLocaleString()}<div>${p.health.lastError.message}</div>${p.lastErrorHint && html`<div class="hint">→ ${p.lastErrorHint}</div>`}${p.health.lastError.stderrTail?.length > 0 && html`<pre class="log" style="margin-top:8px">${p.health.lastError.stderrTail.join('\n')}</pre>`}</div>`}
    <div class="tabs">${[['overview', 'Overview'], ['permissions', `Permissions (${p.permissions.length})`], ['settings', 'Settings'], ['secrets', 'Secrets'], ['logs', 'Logs'], ['activity', 'Activity']].map(([k, label]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${label}</button>`)}</div>
    ${tab === 'overview' && html`<div class="grid">
      <div class="card"><h3 style="margin-top:0">Runtime</h3><dl class="kv small">
        <dt>runtime</dt><dd>${p.manifest.runtime.type} · ${p.manifest.runtime.entry || (p.manifest.runtime.command || []).join(' ')}</dd>
        <dt>process</dt><dd>${p.process ? `${p.process.state}${p.process.pid ? ` · pid ${p.process.pid}` : ''}` : 'not running (starts on demand)'}</dd>
        <dt>isolation</dt><dd>${p.isolation?.level}${p.isolation?.reason ? ` — ${p.isolation.reason}` : ''}</dd>
        <dt>engines</dt><dd>helm ${p.manifest.engines.helm} · protocol ${p.manifest.engines.protocol}</dd>
        <dt>source</dt><dd>${p.source.type}: ${p.source.location}</dd>
        <dt>folder</dt><dd class="mono">${p.dir}</dd>
        <dt>installed</dt><dd>${new Date(p.installedAt).toLocaleString()}</dd>
        <dt>crashes (5 min)</dt><dd>${p.health.crashes.length}</dd>
      </dl></div>
      <div class="card"><h3 style="margin-top:0">Contributes</h3>
        ${c.tools.map((t) => html`<div class="spread small" style="padding:3px 0"><span><span class="mono">${t.exposedName}</span> <span class="muted">${t.effect}</span></span>${t.available ? html`<${Badge} tone="ok">ready<//>` : html`<${Badge} tone="warn" title=${t.reason}>${t.reason}<//>`}</div>`)}
        ${c.commands.map((x) => html`<div class="small" style="padding:3px 0">command <span class="mono">${x.qualified}</span> <span class="muted">${x.title}</span></div>`)}
        ${c.hooks.map((x) => html`<div class="small" style="padding:3px 0">hook <span class="mono">${x.event}</span> <span class="muted">${x.mode}${x.onError === 'block' ? ', fail-closed' : ''}</span> ${!x.available && html`<${Badge} tone="warn">${x.reason}<//>`}</div>`)}
        ${c.panels.map((x) => html`<div class="small" style="padding:3px 0">panel <span class="mono">${x.qualified}</span> <span class="muted">${x.title}</span></div>`)}
        ${c.providers.map((x) => html`<div class="small" style="padding:3px 0">model provider <span class="mono">${x.qualified}</span> <span class="muted">${x.defaultModel || ''}</span></div>`)}
      </div></div>`}
    ${tab === 'permissions' && html`<${Permissions} plugin=${p} onChange=${setP} />`}
    ${tab === 'settings' && html`<div class="card"><${ConfigForm} plugin=${p} onSaved=${setP} /></div>`}
    ${tab === 'secrets' && html`<${Secrets} plugin=${p} onChange=${setP} />`}
    ${tab === 'logs' && html`<div><div class="spread"><span class="muted small">stderr, SDK logs and lifecycle events · secrets redacted</span><button class="btn sm" onClick=${reload}>Refresh</button></div><pre class="log" style="margin-top:8px">${p.logs.length ? p.logs.join('\n') : '(no log yet — the plugin has not run)'}</pre></div>`}
    ${tab === 'activity' && html`<${AuditTable} rows=${p.audit} />`}
  </div>`;
}

// ---------------------------------------------------------------- marketplace
function Market({ go, setPlan }) {
  const [q, setQ] = useState('');
  const [state, reload] = useAsync(() => api(`/api/registry?q=${encodeURIComponent(q)}`), [q]);
  const [spec, setSpec] = useState('');
  useEvents((type) => { if (type === 'changed') reload(); }, [reload]);
  const prepare = async (s) => { try { setPlan(await api('/api/install/prepare', { method: 'POST', body: { spec: s } })); } catch (e) { toastError(e); } };
  return html`<div class="page">
    <h1>Marketplace</h1><p class="sub">Plugins from your registries. Helm reads each manifest — without running any code — so you see exactly what a plugin will ask for before installing it.</p>
    <div class="row"><input type="text" placeholder="Search plugins" value=${q} onInput=${(e) => setQ(e.target.value)} style="max-width:360px" /></div>
    <div class="grid" style="margin-top:14px">${(state.data || []).map((e) => html`<div class="card">
      <div class="spread"><div><div class="title" style="font-weight:620;font-size:15px">${e.name}</div><div class="mono small muted">${e.id}@${e.version}</div></div>
        ${e.installed ? html`<button class="btn sm" onClick=${() => go('plugin', e.id)}>Installed ${e.installed}</button>` : html`<button class="btn sm primary" onClick=${() => prepare(e.id)}>Install…</button>`}</div>
      <p style="margin:8px 0">${e.description}</p>
      <div class="chips">${(e.permissions.length ? e.permissions : ['no permissions']).map((p) => html`<${Badge}>${p}<//>`)}</div>
    </div>`)}</div>
    <h2>Install from elsewhere</h2>
    <div class="card"><div class="row"><input type="text" placeholder="/path/to/plugin, ./my-plugin-1.0.0.hplugin.tgz, or https://github.com/you/plugin.git" value=${spec} onInput=${(e) => setSpec(e.target.value)} style="flex:1" /><button class="btn primary" disabled=${!spec} onClick=${() => prepare(spec)}>Review & install</button></div>
    <div class="small muted" style="margin-top:6px">Folders are copied (use <span class="mono">helm plugin dev</span> to link one for development). Git URLs are cloned without running any scripts.</div></div>
  </div>`;
}

// ---------------------------------------------------------------- tools & commands
function Tools() {
  const [tools, reloadT] = useAsync(() => api('/api/tools'), []);
  const [cmds, reloadC] = useAsync(() => api('/api/commands'), []);
  const [result, setResult] = useState();
  useEvents((type) => { if (type === 'changed') { reloadT(); reloadC(); } }, []);
  const run = async (cmd) => {
    let args = {};
    if (cmd.args && Object.keys(cmd.args.properties || {}).length) {
      const raw = prompt(`Arguments for ${cmd.qualified} (JSON)`, JSON.stringify(Object.fromEntries(Object.keys(cmd.args.properties).map((k) => [k, '']))));
      if (raw === null) return;
      try { args = Object.fromEntries(Object.entries(JSON.parse(raw)).filter(([, v]) => v !== '')); } catch { return toastError({ message: 'Invalid JSON' }); }
    }
    try { setResult({ cmd, res: await api('/api/commands/run', { method: 'POST', body: { plugin: cmd.plugin, command: cmd.name, args } }) }); } catch (e) { setResult({ cmd, error: e }); }
  };
  return html`<div class="page">
    <h1>Tools & commands</h1><p class="sub">Tools are what the model can call; commands are actions you run. Unavailable entries say why.</p>
    <div class="card"><table class="t"><thead><tr><th>tool</th><th>plugin</th><th>effect</th><th>status</th></tr></thead><tbody>
      ${(tools.data || []).map((t) => html`<tr><td><div class="mono">${t.name}</div><div class="small muted">${t.description}</div></td><td>${t.pluginName}</td><td><${Badge} tone=${t.effect === 'read' ? '' : 'warn'}>${t.effect}<//></td><td>${t.available ? html`<${Badge} tone="ok">ready<//>` : html`<span class="small" style="color:var(--warn)">${t.reason}</span>`}</td></tr>`)}
    </tbody></table></div>
    <h2>Commands</h2>
    <div class="card"><table class="t"><tbody>${(cmds.data || []).map((x) => html`<tr><td class="mono">${x.qualified}</td><td>${x.title}</td><td style="text-align:right">${x.available ? html`<button class="btn sm" onClick=${() => run(x)}>Run</button>` : html`<span class="small muted">${x.reason}</span>`}</td></tr>`)}</tbody></table></div>
    ${result && html`<div class="overlay" onClick=${() => setResult(undefined)}><div class="modal" onClick=${(e) => e.stopPropagation()}>
      <h2>${result.cmd.title}</h2>
      ${result.error ? html`<${ErrorBox} error=${result.error} />` : html`<div><${UINode} node=${result.res.ui} />${(result.res.content || []).map((b) => html`<pre class="log">${b.type === 'json' ? JSON.stringify(b.data, null, 2) : b.text}</pre>`)}</div>`}
      <div class="actions"><button class="btn" onClick=${() => setResult(undefined)}>Close</button></div></div></div>`}
  </div>`;
}

// ---------------------------------------------------------------- audit
function AuditTable({ rows }) {
  if (!rows?.length) return html`<div class="card empty">No entries yet.</div>`;
  return html`<div class="card"><table class="t small"><thead><tr><th>time</th><th>plugin</th><th>kind</th><th>action</th><th>target</th><th>decision</th></tr></thead><tbody>
    ${rows.map((r) => html`<tr><td class="mono">${r.ts.slice(5, 19).replace('T', ' ')}</td><td>${r.plugin}</td><td>${r.kind}</td><td>${r.permission ? html`<span class="mono">${r.permission}</span> ` : ''}${r.action}</td><td class="mono" style="max-width:280px;word-break:break-all">${r.target || ''}</td><td>${r.decision === 'denied' ? html`<${Badge} tone="bad">denied<//>` : r.decision === 'allowed' ? html`<${Badge} tone="ok">allowed<//>` : html`<${Badge}>info<//>`}${r.reason && html`<div class="muted">${r.reason}</div>`}</td></tr>`)}
  </tbody></table></div>`;
}
function Audit() {
  const [denied, setDenied] = useState(false);
  const [state, reload] = useAsync(() => api(`/api/audit?limit=300${denied ? '&denied=1' : ''}`), [denied]);
  useEvents((type) => { if (type === 'changed' || type === 'session') reload(); }, [reload]);
  return html`<div class="page"><div class="spread"><div><h1>Audit trail</h1><p class="sub">Every grant, revocation, approval, hook decision and permission check — newest first.</p></div>
    <label class="switch"><input type="checkbox" checked=${denied} onChange=${(e) => setDenied(e.target.checked)} /> only denials</label></div>
    <${AuditTable} rows=${state.data} /></div>`;
}

// ---------------------------------------------------------------- settings
function Settings({ overview, refresh }) {
  const [providers] = useAsync(() => api('/api/providers'), []);
  const cfg = overview?.config;
  const [model, setModel] = useState(cfg?.model || '');
  const [models, setModels] = useState();
  const [filter, setFilter] = useState('');
  useEffect(() => setModel(cfg?.model || ''), [cfg?.model]);
  if (!cfg) return null;
  const save = (body) => api('/api/settings', { method: 'PUT', body }).then(() => { refresh(); pushToast({ text: 'Settings saved' }); }, toastError);
  const loadModels = () => api(`/api/models${cfg.provider ? `?provider=${encodeURIComponent(cfg.provider)}` : ''}`).then(setModels, toastError);
  const shown = (models?.models || []).filter((m) => !filter || m.id.includes(filter)).slice(0, 80);
  return html`<div class="page">
    <h1>Settings</h1><p class="sub">Host settings. Plugin settings live on each plugin's page.</p>
    <div class="grid">
      <div class="card"><h3 style="margin-top:0">Model provider</h3>
        <label class="field"><span>Provider</span><select value=${cfg.provider || ''} onChange=${(e) => save({ provider: e.target.value })}>
          <option value="">(first available)</option>${(providers.data || []).map((p) => html`<option value=${p.qualified} disabled=${!p.available}>${p.title} — ${p.qualified}${p.available ? '' : ' (unavailable)'}</option>`)}</select>
          <small>Providers are plugins too. The core has none built in.</small></label>
        <label class="field"><span>Model</span><div class="row"><input type="text" placeholder=${overview.provider?.model || 'provider default'} value=${model} onInput=${(e) => setModel(e.target.value)} style="flex:1" /><button class="btn" onClick=${() => save({ model })}>Save</button></div>
          <small>Current: ${overview.provider?.model || '—'}</small></label>
        <button class="btn sm" onClick=${loadModels}>Browse models</button>
      </div>
      <div class="card"><h3 style="margin-top:0">Tool approvals</h3>
        ${['read', 'write', 'external', 'exec'].map((k) => html`<label class="field"><span>${k} tools</span><select value=${cfg.approvals[k]} onChange=${(e) => save({ approvals: { ...cfg.approvals, [k]: e.target.value } })}>${['allow', 'ask', 'deny'].map((o) => html`<option value=${o}>${o}</option>`)}</select></label>`)}
      </div>
      <div class="card"><h3 style="margin-top:0">Security</h3>
        <label class="switch"><input type="checkbox" checked=${cfg.security.requireStrictIsolation} onChange=${(e) => save({ requireStrictIsolation: e.target.checked })} /> Require the full macOS sandbox for untrusted plugins</label>
        <p class="small muted">When the sandbox is unavailable (e.g. Helm runs inside another sandbox), untrusted plugins refuse to start instead of silently running with weaker isolation.</p>
        <dl class="kv small"><dt>sandbox</dt><dd>${overview.host.sandbox.available ? 'available' : overview.host.sandbox.reason}</dd><dt>home</dt><dd class="mono">${overview.host.home}</dd><dt>workspace</dt><dd class="mono">${overview.host.workspace}</dd></dl>
        <label class="field" style="margin-top:10px"><span>Max agent steps per message</span><input type="number" value=${cfg.agent.maxSteps} onChange=${(e) => save({ maxSteps: Number(e.target.value) })} /></label>
      </div>
    </div>
    ${models && html`<h2>Models from ${models.provider}</h2><div class="card"><input type="text" placeholder="filter" value=${filter} onInput=${(e) => setFilter(e.target.value)} style="max-width:300px;margin-bottom:10px" />
      <table class="t small"><thead><tr><th>model</th><th>role</th><th>context</th><th>$/1M in · out</th><th></th></tr></thead><tbody>
      ${shown.map((m) => html`<tr><td class="mono">${m.id}</td><td>${m.recommended || ''}</td><td>${m.contextLength || ''}</td><td>${m.pricing ? `${m.pricing.inputPerM?.toFixed(2)} · ${m.pricing.outputPerM?.toFixed(2)}` : ''}</td><td style="text-align:right">${m.blocked ? html`<${Badge} tone="bad" title=${m.reason}>blocked by policy<//>` : html`<button class="btn sm" onClick=${() => { setModel(m.id); save({ model: m.id }); }}>Use</button>`}</td></tr>`)}
      </tbody></table></div>`}
  </div>`;
}

// ---------------------------------------------------------------- app
function App() {
  const [view, setView] = useState(parseRoute);
  useEffect(() => { const on = () => setView(parseRoute()); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);
  const [overview, setOverview] = useState();
  const [error, setError] = useState();
  const [plan, setPlan] = useState();
  const [connected, setConnected] = useState(true);
  const refresh = useCallback(() => api('/api/overview').then((o) => { setOverview(o); setError(undefined); }, setError), []);
  useEffect(() => { refresh(); const es = connectEvents(); return () => es.close(); }, []);
  const timer = useRef();
  useEvents((type, data) => {
    if (type === 'hello') setConnected(true);
    if (type === 'disconnected') setConnected(false);
    if (type === 'changed' || type === 'plugin.state') { clearTimeout(timer.current); timer.current = setTimeout(refresh, 250); }
    if (type === 'plugin.notify') pushToast({ kind: data.level === 'error' ? 'error' : data.level === 'warn' ? 'warn' : '', text: `${data.plugin}: ${data.message}` });
    if (type === 'plugin.state' && (data.to === 'crashed' || data.to === 'quarantined')) pushToast({ kind: 'error', text: `${data.plugin} ${data.to}`, hint: data.reason });
  }, []);
  const go = (name, id) => { location.hash = '#/' + name + (id ? '/' + encodeURIComponent(id) : ''); };
  if (!TOKEN) return html`<div class="page"><h1>Helm console</h1><div class="err">Open the console with the link printed by <span class="mono">helm serve</span> (it contains a one-time access token).</div></div>`;
  if (error && !overview) return html`<div class="page"><h1>Helm console</h1><${ErrorBox} error=${error} /></div>`;
  const bad = (overview?.plugins || []).filter((p) => p.availability.code === 'PLUGIN_QUARANTINED' || (p.enabled && !p.availability.available)).length;
  const nav = [['chat', 'Chat'], ['plugins', 'Plugins', overview?.plugins.length, bad], ['market', 'Marketplace'], ['tools', 'Tools & commands', overview?.tools.ready], ['audit', 'Audit trail'], ['settings', 'Settings']];
  return html`<div class="shell">
    <nav class="side">
      <div class="brand"><img src="/helm.svg" alt="" /><div>Helm<small>local agent harness</small></div></div>
      <div class="nav">${nav.map(([k, label, count, alert]) => html`<button class=${view.name === k || (k === 'plugins' && view.name === 'plugin') ? 'on' : ''} onClick=${() => go(k)}><span>${label}</span>${count !== undefined && html`<span class=${'count' + (alert ? ' alert' : '')}>${alert ? `${alert} !` : count}</span>`}</button>`)}</div>
      <div class="side-foot">
        <div><span class=${'dot' + (overview?.host.sandbox.available ? '' : ' warn')}></span>${overview?.host.sandbox.available ? 'strict sandbox' : 'sandbox unavailable'}</div>
        <div title=${overview?.host.workspace}>${(overview?.host.workspace || '').split('/').slice(-2).join('/')}</div>
        <div>v${overview?.host.version}${connected ? '' : ' · reconnecting…'}</div>
      </div>
    </nav>
    <main class="main">
      ${view.name === 'chat' && html`<${Chat} overview=${overview} />`}
      ${view.name === 'plugins' && html`<${PluginList} overview=${overview} go=${go} />`}
      ${view.name === 'plugin' && html`<${PluginDetail} id=${view.id} go=${go} setPlan=${setPlan} />`}
      ${view.name === 'market' && html`<${Market} go=${go} setPlan=${setPlan} />`}
      ${view.name === 'tools' && html`<${Tools} />`}
      ${view.name === 'audit' && html`<${Audit} />`}
      ${view.name === 'settings' && html`<${Settings} overview=${overview} refresh=${refresh} />`}
    </main>
    ${plan && html`<${Consent} plan=${plan} onCancel=${() => setPlan(undefined)} onDone=${(p) => { setPlan(undefined); refresh(); go('plugin', p.id); }} />`}
    <${Approvals} initial=${overview?.pendingApprovals} />
    <${Toasts} />
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
