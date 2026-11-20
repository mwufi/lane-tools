---
name: lane-setup
description: Set up and use lanes (one shared cloud Convex backend per git branch, shared by every agent on it). Use when asked to set up lanes, when starting work on a branch in a repo that uses lanes, or before testing backend changes against a shared branch backend.
---

# Lane Setup

A **lane** is one shared cloud backend (a Convex deployment with seed data) per git branch.
Every agent on that branch (Claude, Codex, Cursor, Amp, or a person) uses the same backend and
shows up on the branch's lane page. The lane runs what is **pushed** to the branch, never anyone's
working tree. The `lane` CLI is the same for every agent vendor.

## 1. Check the machine (every session, takes a second)

```sh
lane doctor
```

Fix whatever it marks FAIL, in this order:

| FAIL line | Fix |
|---|---|
| `lane: command not found` | `npm install -g github:mwufi/lane-tools` (needs Node 20+) |
| control plane unset | Ask the person for their lane-control URL (`https://<name>.convex.site`), then `lane init --url <url>` |
| token missing / rejected | The person provides it. **Never ask them to paste a token into chat and never print one.** Ask them to set `LANE_TOKEN` in their shell profile or their agent environment's secrets, or to run `lane init --url <url> --token-stdin < token-file` themselves. |
| can't reach the URL | The environment's network policy must allow `*.convex.site`, `*.convex.cloud` and `api.convex.dev`. Tell the person; don't try to work around it. |
| repo is NOT registered | A lane-control admin registers it once (`npx convex run admin:registerRepo ...`, see the lane-tools README). Tell the person; it is not something an agent should do on its own. |

**Cloud agents** (Claude Code on the web, Codex cloud, Cursor background agents) start on a fresh
machine each time. The person sets this up once per vendor, in that vendor's environment settings:
`LANE_URL` and `LANE_TOKEN` as environment variables/secrets, and
`npm install -g github:mwufi/lane-tools` in the setup script. Explain that; don't do it for them.

Nothing gets committed to the repo for lanes. `lane` keeps its files (`.lane/`, `.env.local`) out
of git via `.git/info/exclude`.

## 2. Personal agent instructions (one time, ask first)

Offer to add this block to the person's own agent instructions so every future session follows
it, and only write it after they say yes. Use the file for the agent they run:
Claude Code `~/.claude/CLAUDE.md`, Codex `~/.codex/AGENTS.md`, Cursor "User Rules" in settings
(they paste it), Amp its user-level AGENTS.md.

```md
## Lanes (shared per-branch backends)
- In repos that use lanes, on a feature branch: run `lane join --task "<one line: what you're doing>"` before starting. Read the backend URLs from `.env.local`. `lane status` shows what other agents on the branch are doing.
- Backend (convex/) changes reach the shared lane only by commit + `lane push` (instead of `git push`). It waits until your commit is live; test after it returns. Never run `npx convex deploy` or `npx convex dev` against the lane.
- Frontend work needs no push: point the local dev server at the lane URLs.
- When finished: `lane leave`. Never run `lane down` unless the person asks; it removes the backend for everyone on the branch.
```

## 3. Working on a branch

```sh
lane join --task "Add emoji reactions"   # creates or joins this branch's lane; writes .env.local
lane status                              # URLs, deployed vs HEAD, other agents, recent activity
# ...edit...
git commit -am "..." && lane push        # backend change: deploys and waits until live (~1 min on big apps)
lane push                                # frontend-only change: no deploy, instant
lane wait                                # if someone else pushed, wait for HEAD to be live
lane key                                 # 4h key for this lane only, saved to .lane/deploy-key, for `npx convex run`
lane leave                               # mark yourself done on the lane page
```

- `lane join` on a branch that isn't pushed yet creates the lane but deploys nothing; the first
  `lane push` deploys and seeds it.
- If someone did a plain `git push`, the next `lane join` or `lane push` catches the lane up.
- If `lane push` reports a failed deploy, the lane keeps running the previous commit. Read the
  Convex error it printed, fix, commit, `lane push` again.
- Use the key only with `npx convex run` / logs against this lane. Never print it or commit it.

## 4. Report back

After setup, tell the person in one or two lines: which checks passed, the lane page URL
(`lane page`), and anything they still need to do themselves (token, network, registration).
