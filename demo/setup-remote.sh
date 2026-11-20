#!/usr/bin/env bash
# Stand-in for GitHub in the demo: a bare repo whose post-receive hook does what
# the GitHub webhook + lane-deployer Action do (report the push, deploy if convex/ changed).
set -euo pipefail
DEMO=${DEMO:-$HOME/demo}
LANE_CLI=${LANE_CLI:-$(cd "$(dirname "$0")/.." && pwd)/cli/lane.mjs}
APP_SRC=${APP_SRC:-$(cd "$(dirname "$0")/.." && pwd)/examples/pingpal}
rm -rf "$DEMO"; mkdir -p "$DEMO/remote" "$DEMO/agents"
git init -q --bare -b main "$DEMO/remote/pingpal.git"
git -C "$DEMO/remote/pingpal.git" config lane.repo demo/pingpal
cat > "$DEMO/remote/pingpal.git/hooks/post-receive" <<HOOK
#!/usr/bin/env bash
export LANE_URL="\${LANE_URL:-$LANE_URL}"
export LANE_TOKEN="\$(cat \${LANE_DEPLOYER_TOKEN_FILE:-$LANE_DEPLOYER_TOKEN_FILE})"
export LANE_DEPLOYER=lane-deployer
exec node "$LANE_CLI" hook post-receive
HOOK
chmod +x "$DEMO/remote/pingpal.git/hooks/post-receive"
# Seed main with the sample app.
tmp=$(mktemp -d); cp -r "$APP_SRC"/. "$tmp"; rm -rf "$tmp/node_modules" "$tmp/convex/_generated" "$tmp/.env.local"
git -C "$tmp" init -q -b main; git -C "$tmp" add -A
git -C "$tmp" -c user.name=seed -c user.email=seed@example.com commit -qm "pingpal: message your friends"
git -C "$tmp" push -q "$DEMO/remote/pingpal.git" main
rm -rf "$tmp"
echo "remote ready at $DEMO/remote/pingpal.git"
