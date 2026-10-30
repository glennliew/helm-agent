#!/bin/zsh
# Helm acceptance demo. Reproduces the checklist from PLAN.md §15 in a throwaway Helm home, so
# nothing touches ~/.helm-agent. Run from a normal terminal (not an IDE/agent sandbox) to see
# strict isolation; elsewhere the demo trusts plugins explicitly and says so.
#
#   npm run demo                 # offline (mock model)
#   OPENROUTER_API_KEY=... npm run demo   # or put it in ./.env: adds a live OpenRouter session
setopt NO_NOMATCH
ROOT=${0:A:h:h}
HELM=$ROOT/bin/helm
DEMO=$(mktemp -d /tmp/helm-demo.XXXXXX)
export HELM_AGENT_HOME=$DEMO/home
WS=$DEMO/ws
mkdir -p $WS
cd $WS

B=$'\e[1m'; D=$'\e[2m'; C=$'\e[36m'; Y=$'\e[33m'; R=$'\e[0m'
[[ -n ${NO_COLOR:-} ]] && B= D= C= Y= R=
n=0
step() { n=$((n + 1)); print -r -- ""; print -r -- "${B}${C}── ${n}. $1${R}"; }
h() { print -r -- "${D}\$ helm $*${R}"; $HELM "$@"; local s=$?; (( s )) && print -r -- "${D}(exit $s)${R}"; return 0; }
note() { print -r -- "${Y}$1${R}"; }

# A small workspace: a git repo with notes and a credential file the agent must never see.
print "# Demo project\nHelm demo workspace." > README.md
print "Ship's log: the helm steers the vessel; the rudder follows." > notes.txt
print "OPENROUTER_API_KEY=sk-or-v1-$(printf 'd%.0s' {1..48})" > .env
print ".env" > .gitignore
git init -q -b main && git -c user.name=Demo -c user.email=demo@example.com add -A >/dev/null && git -c user.name=Demo -c user.email=demo@example.com commit -qm "initial" >/dev/null
git config user.name Demo; git config user.email demo@example.com

print -r -- "${B}Helm demo${R} ${D}home $HELM_AGENT_HOME · workspace $WS${R}"

step "doctor: runtimes and isolation"
h doctor
SANDBOX=$($HELM doctor --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); d=d["checks"] if isinstance(d,dict) else d; print(next((c["ok"] is True for c in d if c["check"]=="sandbox"), False))' 2>/dev/null)

step "discover and install (consent screens; --yes grants what each plugin asks)"
h plugin search
h init --yes --secrets file
if [[ $SANDBOX != True ]]; then
  note "The macOS sandbox can't be applied in this terminal, so untrusted plugins refuse to start (shown next)."
  h run -p helm.mock-model/mock 'call files__list_dir {}'
  note "Trusting the bundled plugins explicitly for this demo:"
  for id in helm.files helm.git helm.web helm.guard helm.mock-model helm.openrouter; do h plugin trust $id >/dev/null; done
fi
h provider use helm.mock-model/mock
h plugin list
h plugin info helm.files

step "the agent uses plugin tools (offline mock model)"
h run 'call files__read_file {"path":"notes.txt"}'
h run 'call git__git_status'
h run 'call web__web_search {"query":"ship helm"}'
h tools

step "Guard (a hook plugin) blocks credential files and redacts secrets"
h run 'call files__read_file {"path":".env"}'
h panel guard.activity
h audit -n 12

step "revoke fs.write: write_file disappears on the next turn; grant restores it"
h plugin revoke helm.files fs.write
h tools
h run --yes 'call files__write_file {"path":"out.txt","content":"x"}'
h plugin grant helm.files fs.write
h run --yes 'call files__write_file {"path":"out.txt","content":"hello"}'
print -r -- "${D}out.txt: $(cat out.txt 2>/dev/null || echo '(missing)')${R}"

step "crashes, hangs and runaway memory stay inside the plugin"
h plugin install $ROOT/tests/fixtures/plugins/echo --link --yes
[[ $SANDBOX != True ]] && h plugin trust test.echo >/dev/null
h plugin limit test.echo callTimeoutMs 1500
h plugin call test.echo slow ms=5000
h plugin call test.echo hog
h plugin call test.echo crash
h plugin call test.echo crash
h plugin call test.echo crash
h plugin list
h plugin call test.echo echo text=still-quarantined
h plugin reset test.echo
h plugin call test.echo echo text=recovered

step "escape attempts are contained (direct file, network, process and env access)"
h plugin untrust test.echo
h plugin call test.echo read_home path=$HOME/.ssh/id_rsa
h plugin call test.echo direct_net
h plugin call test.echo spawn
h plugin call test.echo env
note "The same attempts from Python, which has no runtime permission layer: only the OS sandbox stops these."
h plugin install $ROOT/tests/fixtures/plugins/py-escape --link --yes
h plugin call test.py-escape read_file path=$HOME/.ssh/id_rsa
h plugin call test.py-escape write_file path=$HOME/helm-escaped.txt
h plugin call test.py-escape connect host=1.1.1.1 port=443
h plugin call test.py-escape spawn
h audit --denied -n 6
[[ $SANDBOX != True ]] && note "(Without the OS sandbox these refuse to start at all: that is the point of strict-by-default.)"

step "version compatibility: a plugin for a newer Helm is refused with a reason"
OLD=$DEMO/oldie; cp -R $ROOT/tests/fixtures/plugins/echo $OLD
python3 - $OLD/helm-plugin.json <<'EOF'
import json, sys
p = sys.argv[1]; m = json.load(open(p)); m["id"] = "test.oldie"; m["engines"]["helm"] = ">=9.0.0"; json.dump(m, open(p, "w"), indent=2)
EOF
h plugin install $OLD --yes

step "update asks only for new permissions; rollback restores the old version"
NEW=$DEMO/files-1.1.0; cp -R $ROOT/plugins/files $NEW
python3 - $NEW/helm-plugin.json <<'EOF'
import json, sys
p = sys.argv[1]; m = json.load(open(p)); m["version"] = "1.1.0"
m["permissions"].append({"id": "net.http", "scope": ["api.github.com"], "optional": True, "reason": "Demo: a new permission introduced by an update."})
json.dump(m, open(p, "w"), indent=2)
EOF
h plugin update helm.files $NEW --yes
h plugin permissions helm.files
h plugin rollback helm.files
h plugin list

step "plugin developer loop: scaffold, test, validate, pack"
cd $DEMO
h plugin new word-tools
h plugin test word-tools
h plugin validate word-tools
h plugin new py-tools --lang python
h plugin test py-tools
h plugin pack word-tools
cd $WS

KEY=${OPENROUTER_API_KEY:-}
[[ -z $KEY && -f $ROOT/.env ]] && KEY=$(grep -E '^OPENROUTER_API_KEY=' $ROOT/.env | head -1 | cut -d= -f2-)
step "live model (OpenRouter)"
if [[ -n $KEY ]]; then
  OPENROUTER_API_KEY=$KEY h secrets set helm.openrouter API_KEY --from-env OPENROUTER_API_KEY
  h provider use helm.openrouter/openrouter
  h run "Read notes.txt, check the git status, and search the web for 'ship's helm'. Then answer in two sentences: what does the log say, and is the repo clean?"
else
  note "No OPENROUTER_API_KEY in the environment or $ROOT/.env; skipped."
fi

print -r -- ""
print -r -- "${B}Done.${R} ${D}Inspect the demo home with: HELM_AGENT_HOME=$HELM_AGENT_HOME $HELM serve${R}"
