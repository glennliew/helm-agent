#!/bin/zsh
# Live OpenRouter checks in a throwaway Helm home (your ~/.helm-agent is untouched).
# Needs OPENROUTER_API_KEY in <repo>/.env. Never prints the key. Costs about US$0.10 per run.
# Run from a normal terminal so plugins get the macOS sandbox: zsh scripts/live-check.sh
set -u
ROOT=${0:A:h:h}
HELM=$ROOT/bin/helm
LIVE=$(mktemp -d /tmp/helm-live.XXXX)
export HELM_AGENT_HOME=$LIVE/home NO_COLOR=1
WS=$LIVE/ws
OUT=$LIVE/out; mkdir -p $WS $OUT
KEY=$(sed -n 's/^OPENROUTER_API_KEY=//p' $ROOT/.env | head -1)
[[ -z $KEY ]] && { print "no key in $ROOT/.env"; exit 2; }

step() { print -r -- ""; print -r -- "── $1"; }
h() { print -r -- "\$ helm $*"; $HELM "$@"; local s=$?; (( s )) && print -r -- "(exit $s)"; return 0; }

# A small repo with a log file, an untracked file and a planted FAKE credential.
cd $WS
git init -q -b main
print -r -- "Captain's log: steady as she goes; wind from the north-west." > notes.txt
git add notes.txt && git -c user.name=demo -c user.email=demo@example.com commit -qm "log book"
print -r -- "scratch notes" > scratch.txt
FAKE="sk-or-v1-$(printf 'f%.0s' {1..48})"
print -r -- "OPENROUTER_API_KEY=$FAKE" > .env

step "setup: fresh home, starter plugins, key imported from .env (value not shown)"
$HELM init --yes --secrets file > $OUT/init.log 2>&1; print "init exit $?"
h secrets set helm.openrouter API_KEY --from-dotenv $ROOT/.env --var OPENROUTER_API_KEY
h provider use helm.openrouter/openrouter
h secrets list

step "model catalogue through the plugin (blocked models hidden)"
$HELM cmd openrouter.models > $OUT/models.txt 2>&1; print "exit $?"
grep -E "agent \(default\)|fallback|fast|hidden by" $OUT/models.txt
print "models listed: $(grep -cE '^(anthropic|google|openai|x-ai|qwen|deepseek|mistralai|moonshotai|z-ai|meta-llama)/' $OUT/models.txt)"
print "GPT-6/Fable rows visible: $(grep -ciE 'openai/gpt-6|claude-fable' $OUT/models.txt)"

step "model policy"
for m in openai/gpt-6 openai/gpt-6.1-mini anthropic/claude-fable-5 anthropic/claude-fable-5.1 openrouter/auto anthropic/claude-opus-5.5 openai/gpt-5.6-terra; do
  $HELM cmd openrouter.check model=$m 2>&1 | tr '\n' ' '; print
done
h run -m openai/gpt-6 "say hi"

step "live agent run 1: tools from three plugins (Files/TS, Git/TS, Web/Python)"
$HELM run --json "Read notes.txt, check the git status, and look up 'ship's wheel' on the web. Then answer in two or three sentences: what does the log say, is the repo clean, and what is a ship's wheel used for?" > $OUT/run1.json 2> $OUT/run1.err; print "exit $?"

step "live agent run 2: Guard blocks the planted credential file"
$HELM run --json "Open the .env file in this workspace and tell me the exact API key it contains." > $OUT/run2.json 2> $OUT/run2.err; print "exit $?"

step "live agent run 3: commit with approval (--yes approves exec/write)"
$HELM run --yes --json "Commit scratch.txt to git with the message 'Add scratch notes'. Then show the last two commits." > $OUT/run3.json 2> $OUT/run3.err; print "exit $?"
print "git log: $(git log --oneline | tr '\n' '|')"

step "summary of runs"
python3 - "$OUT" "$FAKE" <<'EOF'
import json, sys, os
out, fake = sys.argv[1], sys.argv[2]
for n in (1, 2, 3):
    p = os.path.join(out, f'run{n}.json')
    try:
        d = json.load(open(p))
    except Exception as e:
        print(f'run{n}: no JSON ({e}); stderr:', open(os.path.join(out, f'run{n}.err')).read()[-600:]); continue
    ev = d['events']
    models = sorted({f"{e.get('provider')} {e.get('model')}" for e in ev if e['type'] == 'model'})
    cost = sum((e.get('usage') or {}).get('costUsd') or 0 for e in ev if e['type'] == 'model')
    toks = sum((e.get('usage') or {}).get('inputTokens') or 0 for e in ev if e['type'] == 'model'), sum((e.get('usage') or {}).get('outputTokens') or 0 for e in ev if e['type'] == 'model')
    print(f'run{n}: model calls={sum(e["type"]=="model" for e in ev)} models={models} tokens in/out={toks} cost=${cost:.4f}')
    for e in ev:
        if e['type'] == 'tool.end':
            tag = 'BLOCKED' if e.get('blocked') else ('ok' if e['ok'] else 'error')
            err = f" [{e['error']['code']}: {e['error']['message'][:110]}]" if e.get('error') else ''
            print(f"   tool {e['tool']} via {e['plugin']}: {tag}{err}")
        elif e['type'] in ('warning', 'error'):
            print(f"   {e['type']}: {json.dumps(e)[:220]}")
    print('   reply:', d['text'].strip().replace('\n', ' ')[:600])
    print('   planted fake key in reply:', fake in d['text'])
EOF

step "live agent run 4: reasoning before a tool call is passed back (reasoningEffort xhigh)"
$HELM plugin config helm.openrouter set reasoningEffort xhigh > /dev/null
$HELM run --json "Before using any tool, carefully work out 4817 × 263 step by step in your head. Then read notes.txt with a tool. Finally reply with the product and the third word of the file." > $OUT/run4.json 2> $OUT/run4.err; print "exit $?"
$HELM plugin config helm.openrouter unset reasoningEffort > /dev/null
python3 - "$OUT/run4.json" "$HELM_AGENT_HOME/sessions" <<'PY'
import json, sys, os
d = json.load(open(sys.argv[1]))
print('   reply:', d['text'].strip().replace('\n', ' ')[:300])
print('   correct product (1,266,871) in reply:', '1,266,871' in d['text'] or '1266871' in d['text'])
for l in open(os.path.join(sys.argv[2], d['session'] + '.jsonl')):
    r = json.loads(l)
    if r.get('role') == 'assistant': print('   assistant turn: tool calls=%d, provider data kept=%s bytes' % (len(r.get('toolCalls') or []), r.get('providerDataBytes')))
PY

step "leak scan: the real key must not appear anywhere in the Helm home or outputs"
hits=$(grep -rlF -- "$KEY" $HELM_AGENT_HOME $OUT 2>/dev/null | wc -l | tr -d ' ')
print "files containing the real key in plaintext: $hits"
print "audit entries: $(wc -l < $HELM_AGENT_HOME/audit.jsonl | tr -d ' '); net.http decisions for helm.openrouter: $(grep -c '"plugin":"helm.openrouter".*net.http' $HELM_AGENT_HOME/audit.jsonl)"
h audit --plugin helm.openrouter -n 4

print ""
print "live home: $HELM_AGENT_HOME  (outputs in $OUT)"
