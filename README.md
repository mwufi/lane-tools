# lane-tools

One shared cloud backend per branch, for every agent on it. Claude, Codex, Cursor, Amp or a
person at a laptop all run the same CLI. v0 of the design in "Convex preview control plane".

```
npm install -g github:mwufi/lane-tools
lane login --url https://<lane-control>.convex.site   # once per machine: sign in with GitHub
lane doctor                              # checks node, URL, token, network, repo registered

lane join --task "Add emoji reactions"   # create or reuse this branch's lane, register on its page
lane push                                # git push + redeploy if convex/ changed + wait until live
lane status                              # URLs, deployed vs HEAD, other agents, recent activity
git push                                 # the lane follows the branch: convex/ changed -> redeploy
lane wait --sha HEAD                     # block until your commit is live
lane key                                 # 4h deploy key scoped to this lane (.lane/deploy-key)
lane leave / lane down                   # done / archive the lane (deployment deleted after grace)
```

## No repo changes needed

Nothing has to be committed to the app repo. The repo name comes from the git remote, the control
plane URL and token from `~/.config/lane/`, and `lane` keeps `.lane/` and `.env.local` out of git via
`.git/info/exclude`. `lane push` does the deploy itself, so the GitHub Action and webhook are optional
(useful when the whole team adopts lanes). Agents learn the workflow from the
[Lane Setup skill](skills/lane-setup/SKILL.md), which works for any vendor's agent.

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
- Per-lane env: only names in the repo's `laneEnvAllow` (name -> value regex, full match) can be set with
  `lane env NAME=value` / `POST /api/lane/env`, through a one-use env-write key; lane keys themselves never
  get env-write. Values are kept on the lane and set again if it is re-provisioned.
- Dormant lanes (14 days without activity) are archived by a cron.

## Setup (once per team)

1. Deploy lane-control (below) and register your repos.
2. **GitHub sign-in:** create a GitHub OAuth App (Settings, Developer settings, OAuth Apps). Homepage URL
   `https://<lane-control>.convex.site`, callback URL `https://<lane-control>.convex.site/auth/github/callback`,
   and tick **Enable Device Flow**. On the lane-control deployment set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
   and who may sign in: `LANE_ALLOWED_GITHUB_ORGS` and/or `LANE_ALLOWED_GITHUB_USERS` (comma-separated).
   People then run `lane login`; cloud agent environments use `lane login --print` once and store the result as `LANE_TOKEN`.
3. **Cleanup on merge:** add a webhook on each repo (Settings, Webhooks): payload URL
   `https://<lane-control>.convex.site/github/webhook`, content type `application/json`, a random secret that you
   also set as `GITHUB_WEBHOOK_SECRET` on lane-control, events "Pushes" and "Pull requests". A merged or closed PR
   archives its lane (keys revoked at once, backend deleted after the repo's grace period, 3 days by default).

### Deploying lane-control

Merges to `main` that touch `convex/` deploy it automatically
(`.github/workflows/deploy-control-plane.yml`) once the repo secret `LANE_CONTROL_DEPLOY_KEY`
holds a production deploy key for the lane-control deployment. By hand:

```sh
npm install
CONVEX_DEPLOY_KEY=<control-plane prod key> npx convex deploy
# secrets on the control plane deployment: CONVEX_TEAM_TOKEN, GITHUB_WEBHOOK_SECRET
npx convex run admin:registerRepo '{"repo":"owner/app","convexProjectId":123,"seedFunction":"seed:run","env":{"APP_ENV":"lane"}}'
npx convex run admin:createToken '{"person":"zen"}'      # prints a token once; stored hashed
# optional: env vars a lane may set for itself, e.g. its preview URL
npx convex run admin:setLaneEnvAllow '{"repo":"owner/app","laneEnvAllow":{"SITE_URL":"https://app-git-[a-z0-9-]+-team\\.vercel\\.app"}}'
```

In the app repo, commit `.lane.json` (`{"repo": "owner/app", "url": "https://<control-plane>.convex.site"}`)
and give each agent environment `LANE_TOKEN`.

## Not in v0

Golden seed snapshots (lanes run the seed function once instead), warm pool (cold create is ~1s for
small apps), scratch deployments, the web/tests/browser resource types, GitHub sign-in on the lane page
(it asks for a lane token instead), and a PR status check.
