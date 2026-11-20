#!/usr/bin/env bash
# End-to-end lane demo on the pingpal sample app.
#   two branches -> two lanes; two agents (different vendors) share one lane;
#   pushes redeploy (and skip when convex/ is unchanged); concurrent pushes collapse;
#   teardown via a signed GitHub webhook (PR merged) and via branch delete.
# Needs: LANE_URL, LANE_TOKEN (a person's token), LANE_DEPLOYER_TOKEN_FILE, GITHUB_WEBHOOK_SECRET_FILE.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
LANE="node $HERE/../cli/lane.mjs"
DEMO=${DEMO:-$HOME/demo}
export LANE_URL LANE_TOKEN
NM=$HERE/../examples/pingpal/node_modules   # reused so agents can `npx convex run`

T0=$(date +%s.%N)
now() { echo "$(date +%s.%N) - $T0" | bc | xargs printf '%6.1fs'; }
step() { echo; echo "[$(now)] ### $*"; }
timed() { local s=$(date +%s.%N); "$@"; echo "    (took $(echo "$(date +%s.%N) - $s" | bc | xargs printf '%.1f')s)"; }
quiet_git() { git "$@" 2>&1 | grep -vE 'negotiat|acknowledgments' || true; }
commit() { git add -A && git -c user.name="$1" -c user.email="$1@example.com" -c commit.gpgsign=false commit -qm "$2"; }

agent() { # agent <dir> <vendor> <person>: run the rest as that agent, in its own clone
  local dir=$1 vendor=$2 person=$3; shift 3
  (cd "$DEMO/agents/$dir" && LANE_VENDOR=$vendor LANE_PERSON=$person LANE_MACHINE=cloud "$@")
}

step "Reset: fresh remote (GitHub stand-in) with pingpal on main"
"$HERE/setup-remote.sh" >/dev/null 2>&1
for b in feat/reactions feat/nudges; do
  $LANE down --repo demo/pingpal --branch $b --quiet 2>/dev/null || true
  while st=$($LANE status --repo demo/pingpal --branch $b --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["lane"]["state"])' 2>/dev/null) && [ "$st" != deleted ]; do sleep 2; done
done

# --- Agent A: Claude (this session), on feat/reactions -------------------------------
step "Claude creates feat/reactions and pushes it (no lane yet: lanes start on PR open or lane up)"
git clone -q "$DEMO/remote/pingpal.git" "$DEMO/agents/claude" 2>/dev/null
ln -s "$NM" "$DEMO/agents/claude/node_modules"
(cd "$DEMO/agents/claude" && git checkout -q -b feat/reactions && quiet_git push -q -u origin feat/reactions)

step "Claude: lane join  -> creates the lane, deploys the pushed HEAD, seeds"
(cd "$DEMO/agents/claude" && timed $LANE join --task "Add emoji reactions to messages")

# --- Agent B: Codex, same branch, another machine ------------------------------------
step "Codex joins the SAME lane from its own clone (no provisioning, no deploy)"
git clone -q -b feat/reactions "$DEMO/remote/pingpal.git" "$DEMO/agents/codex" 2>/dev/null
ln -s "$NM" "$DEMO/agents/codex/node_modules"
agent codex codex zen timed $LANE join --task "Reaction picker UI"

step "Both agents see the same backend URL"
grep CONVEX_URL= "$DEMO/agents/claude/.env.local" | sed 's/^/    claude: /'
grep CONVEX_URL= "$DEMO/agents/codex/.env.local" | sed 's/^/    codex:  /'

# --- Agent C: Cursor, a second branch ------------------------------------------------
step "Cursor starts feat/nudges -> a second, separate lane"
git clone -q "$DEMO/remote/pingpal.git" "$DEMO/agents/cursor" 2>/dev/null
(cd "$DEMO/agents/cursor" && git checkout -q -b feat/nudges && quiet_git push -q -u origin feat/nudges)
agent cursor cursor zen timed $LANE join --task "Nudge a friend who hasn't replied"

# --- A backend push redeploys the lane -----------------------------------------------
step "Claude pushes a backend change (reactions) -> lane deployer redeploys"
cd "$DEMO/agents/claude"
python3 - <<'PY'
import re
p='convex/schema.ts'; s=open(p).read()
s=s.replace('    body: v.string(),\n  }).index("by_convo"', '    body: v.string(),\n    reactions: v.optional(v.array(v.object({ emoji: v.string(), n: v.number() }))),\n  }).index("by_convo"')
open(p,'w').write(s)
p='convex/messages.ts'; s=open(p).read()
s+='''
export const react = mutation({
  args: { messageId: v.id("messages"), emoji: v.string() },
  handler: async (ctx, { messageId, emoji }) => {
    const msg = await ctx.db.get("messages", messageId);
    if (!msg) throw new Error("no such message");
    // Emoji can't be object keys in Convex documents, so reactions are a small array.
    const reactions = [...(msg.reactions ?? [])];
    const hit = reactions.find((r) => r.emoji === emoji);
    if (hit) hit.n += 1;
    else reactions.push({ emoji, n: 1 });
    await ctx.db.patch("messages", messageId, { reactions });
    return reactions;
  },
});
'''
open(p,'w').write(s)
PY
commit claude "messages: emoji reactions"
SHA_A=$(git rev-parse HEAD)
PUSH_START=$(date +%s.%N)
quiet_git push -q
$LANE wait --sha "$SHA_A"
echo "    push -> live: $(echo "$(date +%s.%N) - $PUSH_START" | bc | xargs printf '%.1f')s"

step "Codex uses Claude's new function on the shared lane (shared data, scoped 4h key)"
cd "$DEMO/agents/codex"
quiet_git pull -q --rebase
$LANE key
# A freshly minted key can take a moment to become valid, so retry briefly.
for i in 1 2 3 4 5 6; do
  MID=$(CONVEX_DEPLOY_KEY=$(cat .lane/deploy-key) npx convex run messages:thread '{"a":"ada","b":"bo"}' 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["_id"])' 2>/dev/null) && break
  echo "    key not active yet (try $i)"; sleep 2
done
CONVEX_DEPLOY_KEY=$(cat .lane/deploy-key) npx convex run messages:react "{\"messageId\":\"$MID\",\"emoji\":\"🌮\"}" 2>/dev/null | sed 's/^/    react -> /'

step "Codex pushes a frontend-only change -> no deploy, lane marks it live at once"
python3 - <<'PY'
p='index.html'; s=open(p).read()
s=s.replace("""'">' + esc(m.body) + '</div>'""", """'">' + esc(m.body) + (m.reactions ? ' <small>' + m.reactions.map((r) => r.emoji + r.n).join(' ') + '</small>' : '') + '</div>'""")
open(p,'w').write(s)
PY
commit codex "ui: show reactions"
SHA_B=$(git rev-parse HEAD)
s=$(date +%s.%N); quiet_git push -q; $LANE wait --sha "$SHA_B"
echo "    push -> live: $(echo "$(date +%s.%N) - $s" | bc | xargs printf '%.1f')s"
agent codex codex zen $LANE heartbeat --status working

step "Two backend pushes back to back -> one deployer, the second push collapses into a follow-up deploy"
cd "$DEMO/agents/claude"; quiet_git pull -q --rebase
cat >> convex/friends.ts <<'TS'

export const byHandle = query({
  args: { handle: v.string() },
  handler: async (ctx, { handle }) =>
    await ctx.db.query("friends").withIndex("by_handle", (q) => q.eq("handle", handle)).unique(),
});
TS
sed -i '1i import { v } from "convex/values";' convex/friends.ts
commit claude "friends: byHandle"; quiet_git push -q
cd "$DEMO/agents/codex"; quiet_git pull -q --rebase
cat >> convex/messages.ts <<'TS'

export const clearReactions = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    await ctx.db.patch("messages", messageId, { reactions: undefined });
    return null;
  },
});
TS
commit codex "messages: clearReactions"; SHA_C=$(git rev-parse HEAD)
s=$(date +%s.%N); quiet_git push -q
$LANE wait --sha "$SHA_C"
echo "    second push -> live: $(echo "$(date +%s.%N) - $s" | bc | xargs printf '%.1f')s"

step "Lane status as any agent sees it"
$LANE status

if [ -n "${BEFORE_TEARDOWN:-}" ]; then step "Snapshot"; eval "$BEFORE_TEARDOWN"; fi

step "Teardown 1: feat/nudges PR merged -> signed GitHub webhook"
BODY='{"action":"closed","pull_request":{"merged":true,"head":{"ref":"feat/nudges","sha":"x"}},"repository":{"full_name":"demo/pingpal"},"sender":{"login":"mwufi"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$(cat "$GITHUB_WEBHOOK_SECRET_FILE")" | awk '{print $2}')
echo -n "    bad signature -> "; curl -s -o /dev/null -w '%{http_code}\n' -X POST "$LANE_URL/github/webhook" -H 'x-github-event: pull_request' -H 'x-hub-signature-256: sha256=00' -d "$BODY"
echo -n "    good signature -> "; curl -s -X POST "$LANE_URL/github/webhook" -H 'x-github-event: pull_request' -H "x-hub-signature-256: sha256=$SIG" -d "$BODY"; echo

step "Teardown 2: Codex leaves; feat/reactions branch deleted -> archived by the push hook"
agent codex codex zen $LANE leave
cd "$DEMO/agents/claude"; quiet_git push -q origin --delete feat/reactions

step "Waiting for the grace period, then the control plane deletes both deployments"
for b in feat/nudges feat/reactions; do
  until [ "$($LANE status --repo demo/pingpal --branch $b --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["lane"]["state"])')" = deleted ]; do sleep 2; done
  echo "    $b: deleted at $(now)"
done
$LANE list
step "Done"
