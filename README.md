# lane

One shared cloud backend per branch, for every agent on it. Claude, Codex, Cursor, Amp or a
person at a laptop all run the same CLI. v0 of the design in "Convex preview control plane".

```
lane join --task "Add emoji reactions"   # create or reuse this branch's lane, register on its page
lane status                              # URLs, deployed vs HEAD, other agents, recent activity
git push                                 # the lane follows the branch: convex/ changed -> redeploy
lane wait --sha HEAD                     # block until your commit is live
lane key                                 # 4h deploy key scoped to this lane (.lane/deploy-key)
lane leave / lane down                   # done / archive the lane (deployment deleted after grace)
```

## Pieces

| Path | What |
|---|---|
| `convex/` | The control plane, a small Convex app. Tables: `repos`, `tokens` (hashed), `lanes`, `laneAgents`, `laneEvents`, `laneKeys`. Holds the Convex team token; agents never see it. |
| `convex/http.ts` | JSON API for the CLI, `/github/webhook` (HMAC-verified: PR opened -> ensure, push -> record HEAD, PR closed / branch deleted -> archive), and the lane page at `/` and `/lane`. |
| `convex/provision.ts` | The Convex resource type: create a dev deployment, set env, mint scoped keys, revoke, delete. |
| `cli/lane.mjs` | Zero-dependency Node CLI. Detects vendor/thread from env (`CLAUDECODE`, `CODEX_*`, `CURSOR_*`, `AMP_*`, `AI_AGENT`), overridable with `LANE_VENDOR`, `LANE_THREAD_URL`, `LANE_MACHINE`, `LANE_PERSON`. |
| `templates/lane-deployer.yml` | GitHub Action that runs `lane deploy` on pushes. |
| `examples/pingpal/` | "Message your friends" sample app used by the demo. |
| `demo/` | `setup-remote.sh` (a bare git repo + post-receive hook standing in for GitHub), `e2e.sh`, `screenshot.mjs`. |

## Rules it enforces

- `ensure` is idempotent on the unique (repo, branch) row; the first caller provisions.
- Deploys only ever deploy a **pushed** commit, from a clean worktree, under a per-lane lease lock (5 min).
  A push that lands mid-deploy makes the lock holder deploy again with the newest HEAD.
- A push that doesn't touch `convex/` is marked live with no deploy.
- Keys: deployer keys last 31 min, agent keys 4h, each scoped to one deployment and logged; all revoked on archive.
- Archive -> keys revoked now, deployment deleted after `graceMs` (3 days by default). A reopened PR in the grace period gets the same deployment back.
- Dormant lanes (14 days without activity) are archived by a cron.

## Setup

```sh
npm install
CONVEX_DEPLOY_KEY=<control-plane prod key> npx convex deploy
# secrets on the control plane deployment: CONVEX_TEAM_TOKEN, GITHUB_WEBHOOK_SECRET
npx convex run admin:registerRepo '{"repo":"owner/app","convexProjectId":123,"seedFunction":"seed:run","env":{"APP_ENV":"lane"}}'
npx convex run admin:createToken '{"person":"zen"}'      # prints a token once; stored hashed
```

In the app repo, commit `.lane.json` (`{"repo": "owner/app", "url": "https://<control-plane>.convex.site"}`)
and give each agent environment `LANE_TOKEN`.

## Not in v0

Golden seed snapshots (lanes run the seed function once instead), warm pool (cold create is ~1s for
small apps), scratch deployments, the web/tests/browser resource types, GitHub sign-in on the lane page
(it asks for a lane token instead), and a PR status check.
