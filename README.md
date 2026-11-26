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
lane run seed:run '{"n":5}'               # run a Convex function on this branch's lane
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
| `convex/provision.ts` | The Convex resource type: create a preview deployment named `preview/<branch>`, set env, mint scoped keys, revoke, delete. |
| `cli/lane.mjs` | Zero-dependency Node CLI. Detects vendor/thread from env (`CLAUDECODE`, `CODEX_*`, `CURSOR_*`, `AMP_*`, `AI_AGENT`), overridable with `LANE_VENDOR`, `LANE_THREAD_URL`, `LANE_MACHINE`, `LANE_PERSON`. |
| `templates/lanes.yml` | GitHub Action that runs a repo's lanes without a GitHub app: creates and deploys on push, archives on PR close or branch delete. |
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

### Admin panel

`https://<lane-control>.convex.site/admin` is the product's home. Signed out, it explains lanes and
offers GitHub sign-in.

**Setup needs no terminal after the first deploy.** Two credentials, kept apart on purpose:

1. **Claiming** proves you own this lane-control. A fresh install (no admins) shows *Claim this
   install*: enter your GitHub username and paste **lane-control's own deploy key** (the production
   deploy key you deployed it with, e.g. the `LANE_CONTROL_DEPLOY_KEY` repo secret). Lane-control
   checks the key works against its own deployment, saves you as admin and the key as
   `LANE_CONTROL_KEY` (so the panel can edit its own settings), and signs you in. That key never
   creates lanes.
2. **Convex teams** are where lanes get created. Under *Settings, Convex teams*, paste a Convex team
   access token per team. Each repo picks its team, so one lane-control can serve apps in
   different Convex teams. Paste a new token for the same team to rotate it; a team still used by a
   repo can't be removed. `CONVEX_TEAM_TOKEN`, if set, is the default for repos with no team.

*Connect GitHub* is optional: lanes run without it through the GitHub Action in `templates/lanes.yml`, and agents can use minted tokens instead of `lane login`. It adds GitHub sign-in (this panel and `lane login`, which also needs *Enable Device Flow* ticked in the app's settings) and push events. It is one click: lane-control sends a GitHub App manifest, GitHub creates a private
app (sign-in, plus push and pull request events to `/github/webhook`), and the redirect stores its
keys. Install the app on your repos and you're done; no hand-made webhooks. The repo form picks a
Convex team, then lists that team's projects. On a local backend (not Convex cloud) settings fall
back to `npx convex env set` / `npx convex run admin:createToken`. Signed in as an
admin (a GitHub login in `LANE_ADMIN_GITHUB_USERS`), it has:

- **Get started**: a checklist that ticks itself, live, from what lane-control has seen. Global steps
  (Convex connected, GitHub sign-in), then one card per repo (registered, seeded, GitHub connected,
  first lane live, first lane wound down after a merge), then team steps (first agent, previews).
  Each open step has copy-paste values for your install and buttons that do the step.
- **Lanes**: filter, open, archive, and **Retry** failed lanes (the error is shown inline).
- **Repos**: register repos, edit setup functions, deploy args, grace period, per-lane env allowlist,
  and write-only lane env.
- **Tokens**: mint (shown once) and revoke machine tokens.
- **Settings**: admins, allowed orgs/users, the GitHub app or OAuth app, webhook secret (with
  Generate), Convex teams (add, rotate, remove), and lane-control's deploy key. Settings are
  lane-control's own env vars; the panel writes them with that deploy key. You can't remove
  yourself as an admin.
- **Activity**: every GitHub webhook delivery and what happened to it (connected, refused and why,
  ignored, lane created or archived), plus sign-ins.
- **Docs**: concepts, lifecycle, CLI, per-vendor agent setup, previews, security, FAQ.

The page is `ui/admin.html`, plain HTML. Run `npm run build:pages` after editing it to regenerate
`convex/adminPage.ts` (`npm run build:pages -- --check` fails if that file is stale).

### Deploying lane-control

Merges to `main` that touch `convex/` deploy it automatically
(`.github/workflows/deploy-control-plane.yml`) once the repo secret `LANE_CONTROL_DEPLOY_KEY`
holds a production deploy key for the lane-control deployment. By hand:

```sh
npm install
CONVEX_DEPLOY_KEY=<control-plane prod key> npx convex deploy
# secrets on the control plane deployment: GITHUB_WEBHOOK_SECRET, and CONVEX_TEAM_TOKEN as the
# default team (or connect teams per repo in the admin panel)
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
