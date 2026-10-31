#!/bin/zsh
# Live PayPal sandbox check in a throwaway Helm home (your ~/.helm-agent is untouched).
# Needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (Sandbox app) in <repo>/.env. Never prints them.
# Creates real SANDBOX invoices and orders only; no live money moves.
#   zsh scripts/paypal-check.sh            # run from a normal terminal for the macOS sandbox
set -u
ROOT=${0:A:h:h}
HELM=$ROOT/bin/helm
LIVE=$(mktemp -d /tmp/helm-paypal.XXXX)
export HELM_AGENT_HOME=$LIVE/home NO_COLOR=1
mkdir -p $LIVE/ws && cd $LIVE/ws
grep -q '^PAYPAL_CLIENT_ID=.' $ROOT/.env 2>/dev/null && grep -q '^PAYPAL_CLIENT_SECRET=.' $ROOT/.env || { print "Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to $ROOT/.env"; exit 2; }

step() { print -r -- ""; print -r -- "── $1"; }
h() { print -r -- "\$ helm $*"; $HELM "$@"; local s=$?; (( s )) && print -r -- "(exit $s)"; return 0; }
# Call a tool directly and print one field of its JSON result (empty on error; the error goes to stderr).
field() { python3 -c 'import json,sys; d=json.load(sys.stdin); e=d.get("error"); e and print("  error: "+e.get("message","")+("\n  → "+e["hint"] if e.get("hint") else ""), file=sys.stderr); d=(d.get("content") or [{}])[0].get("data") or {}; print(d.get(sys.argv[1]) or "")' "$1"; }

step "setup: fresh home, plugins, sandbox credentials from .env (values not shown)"
$HELM init --yes --secrets file > $LIVE/init.log 2>&1; print "init exit $?"
SANDBOX=$($HELM doctor --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); d=d["checks"] if isinstance(d,dict) else d; print(next((c["ok"] is True for c in d if c["check"]=="sandbox"), False))' 2>/dev/null)
if [[ $SANDBOX != True ]]; then
  print "macOS sandbox unavailable in this terminal: trusting the bundled plugins for this check."
  for id in helm.paypal helm.guard helm.mock-model; do $HELM plugin trust $id > /dev/null; done
fi
h secrets set helm.paypal CLIENT_ID --from-dotenv $ROOT/.env --var PAYPAL_CLIENT_ID
h secrets set helm.paypal CLIENT_SECRET --from-dotenv $ROOT/.env --var PAYPAL_CLIENT_SECRET
h provider use helm.mock-model/mock
h cmd paypal.status

step "1. draft invoice through the agent loop (Guard + approvals apply)"
h run --yes 'call paypal__create_invoice {"recipient_email":"customer@example.com","recipient_name":"Ada Lovelace","items":[{"name":"October retainer","unit_amount":"250"},{"name":"Hosting","quantity":2,"unit_amount":"12.50"}],"note":"Thanks for your business!","due_in_days":14}'

step "2. send it (approval: ask, approved here with --yes)"
INV=$($HELM plugin call helm.paypal create_invoice '{"recipient_email":"customer@example.com","items":[{"name":"Design sprint","unit_amount":"120"}]}' --json | field invoice_id)
if [[ -n $INV ]]; then
  print "invoice: $INV"
  h run --yes "call paypal__send_invoice {\"invoice_id\":\"$INV\"}"
else
  print "No invoice was created, so there is nothing to send (see the error above)."
fi
h run 'call paypal__list_invoices {"page_size":5}'

step "3. checkout order: the buyer approves at the link, then pay_order captures"
ORDER=$($HELM plugin call helm.paypal create_order '{"amount":"49.99","description":"Helm sticker pack"}' --json | field order_id)
print "order: $ORDER"
[[ -n $ORDER ]] && h run "call paypal__get_order {\"order_id\":\"$ORDER\"}"

step "4. spend limits refuse before PayPal is called"
h run --yes 'call paypal__create_order {"amount":"900"}'
h plugin config helm.paypal set dailyLimit 100
h run --yes 'call paypal__create_order {"amount":"80"}'

step "5. without approval, money-moving tools do not run (no terminal to ask = denied)"
h run "call paypal__pay_order {\"order_id\":\"${ORDER:-UNKNOWN}\"}" < /dev/null

step "summary"
h panel paypal.activity
h audit -n 15 --plugin helm.paypal
print ""
print "Sandbox invoices: https://www.sandbox.paypal.com/invoice/s (log in with your sandbox business account)"
print "Throwaway home: $LIVE"
