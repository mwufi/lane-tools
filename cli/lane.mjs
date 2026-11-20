#!/usr/bin/env node
// lane: one shared cloud backend per branch, for every agent on it.
// Vendor-neutral: Claude, Codex, Cursor, Amp, or a person at a laptop all run the same commands.
// Zero dependencies; Node >= 20.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HELP = `lane: shared per-branch cloud backends for every agent

Usage: lane <command> [options]

  up                      Create or reuse this branch's lane, deploy the pushed HEAD, write .env.local
  join --task "..."       up, then register this agent on the lane page (vendor/thread auto-detected)
  status [--json]         Lane state, URLs, deployed vs HEAD, other agents and recent activity
  list                    All lanes
  wait [--sha <sha>]      Block until <sha> (default: origin HEAD) is live on the lane
  deploy                  Deploy the branch's pushed HEAD under the lane lock (what CI/hooks run)
  key [--print]           Mint a 4h deploy key for this lane (saved to .lane/deploy-key)
  heartbeat [--status working|waiting|done] [--task "..."]
  leave                   Mark this agent done
  down                    Archive the lane: revoke keys now, delete the deployment after grace
  page                    Print the lane page URL
  hook post-receive       Git post-receive hook: report pushes and run the deployer

Common options: --repo owner/name  --branch name  --json
Env: LANE_URL (control plane .convex.site URL), LANE_TOKEN,
     optional LANE_VENDOR, LANE_THREAD_URL, LANE_MACHINE, LANE_PERSON`;

// ---------------------------------------------------------------- args & config

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2);
      if (inline !== undefined) out[k] = inline;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

function git(gitArgs, opts = {}) {
  try {
    return execFileSync("git", gitArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...opts }).trim();
  } catch {
    return null;
  }
}

function die(msg) {
  console.error("lane: " + msg);
  process.exit(1);
}

const repoRoot = git(["rev-parse", "--show-toplevel"]);
const gitDir = git(["rev-parse", "--absolute-git-dir"]);
const fileCfg = (() => {
  for (const p of [repoRoot && path.join(repoRoot, ".lane.json"), path.join(os.homedir(), ".config/lane/config.json")]) {
    if (p && fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
      } catch {}
    }
  }
  return {};
})();

const LANE_URL = (process.env.LANE_URL || fileCfg.url || "").replace(/\/$/, "");
const LANE_TOKEN =
  process.env.LANE_TOKEN ||
  (() => {
    const p = path.join(os.homedir(), ".config/lane/token");
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : "";
  })();

function repoId() {
  if (args.repo) return args.repo;
  if (process.env.LANE_REPO) return process.env.LANE_REPO;
  if (fileCfg.repo) return fileCfg.repo;
  const fromConfig = git(["config", "lane.repo"]);
  if (fromConfig) return fromConfig;
  const url = git(["remote", "get-url", "origin"]);
  const m = url && url.match(/[:/]([^/:]+\/[^/]+?)(\.git)?$/);
  if (m) return m[1];
  die("can't tell which repo this is; pass --repo owner/name or add .lane.json");
}

function branchName() {
  if (args.branch) return args.branch;
  if (process.env.LANE_BRANCH) return process.env.LANE_BRANCH;
  const b = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!b || b === "HEAD") die("detached HEAD; pass --branch");
  return b;
}

const stateDir = process.env.LANE_STATE_DIR || path.join(repoRoot || process.cwd(), ".lane");
function readState(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, name), "utf8"));
  } catch {
    return null;
  }
}
function writeState(name, data, mode = 0o644) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, name), typeof data === "string" ? data : JSON.stringify(data, null, 2), { mode });
}

// ---------------------------------------------------------------- agent identity (vendor-neutral)

function detectAgent() {
  const e = process.env;
  let vendor = e.LANE_VENDOR;
  let threadUrl = e.LANE_THREAD_URL;
  let machine = e.LANE_MACHINE;
  if (!vendor) {
    if (e.CLAUDECODE || e.CLAUDE_CODE_ENTRYPOINT) vendor = "claude";
    else if (Object.keys(e).some((k) => k.startsWith("CODEX_"))) vendor = "codex";
    else if (e.CURSOR_AGENT || e.CURSOR_TRACE_ID) vendor = "cursor";
    else if (Object.keys(e).some((k) => k.startsWith("AMP_"))) vendor = "amp";
    else if (e.AI_AGENT) vendor = e.AI_AGENT.split(/[_\s]/)[0].replace(/-code$/, "");
    else vendor = "human";
  }
  if (!threadUrl) {
    if (vendor === "claude" && e.CLAUDE_CODE_REMOTE_SESSION_ID) {
      threadUrl = "https://claude.ai/code/" + e.CLAUDE_CODE_REMOTE_SESSION_ID.replace(/^cse_/, "session_");
    } else if (vendor === "amp" && e.AMP_THREAD_ID) {
      threadUrl = "https://ampcode.com/threads/" + e.AMP_THREAD_ID;
    }
  }
  if (!machine) {
    if (e.CLAUDE_CODE_REMOTE === "true" || e.CODEX_CLOUD || e.CURSOR_BACKGROUND_AGENT) machine = "cloud";
    else if (e.GITHUB_ACTIONS) machine = "ci";
    else machine = "laptop";
  }
  return { vendor, threadUrl, machine };
}

// ---------------------------------------------------------------- HTTP

async function api(method, p, body) {
  if (!LANE_URL) die("LANE_URL is not set (the control plane's .convex.site URL)");
  if (!LANE_TOKEN) die("LANE_TOKEN is not set (ask an admin: npx convex run admin:createToken)");
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(LANE_URL + p, {
        method,
        headers: { authorization: "Bearer " + LANE_TOKEN, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(json.error || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return json;
    } catch (e) {
      lastErr = e;
      if (e.status && e.status < 500) throw e;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s) => (s ? s.slice(0, 7) : "-");
const secs = (ms) => (ms / 1000).toFixed(1) + "s";
const log = (...m) => { if (!args.json && !args.quiet) console.error(...m); };

function pageUrl(repo, branch) {
  return `${LANE_URL}/lane?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`;
}

async function getLane(repo, branch) {
  return await api("GET", `/api/lane?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`);
}

// ---------------------------------------------------------------- git helpers

function remoteHead(branch) {
  if (git(["remote"])?.split("\n").includes("origin")) {
    git(["fetch", "--quiet", "origin", branch]);
    return git(["rev-parse", `refs/remotes/origin/${branch}`]) || git(["rev-parse", "FETCH_HEAD"]);
  }
  // Inside a bare repo (git hook) the branch ref is the pushed head.
  return git(["rev-parse", `refs/heads/${branch}`]);
}

function isAncestor(a, b) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", a, b], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- commands

async function up({ quiet = false } = {}) {
  const repo = repoId();
  const branch = branchName();
  const t0 = Date.now();
  const headSha = remoteHead(branch) || undefined;
  const ensured = await api("POST", "/api/lane/ensure", { repo, branch, headSha });
  if (!quiet) log(`${ensured.created ? "Creating" : "Joining"} lane ${repo}@${branch}`);
  let v = await getLane(repo, branch);
  while (v.lane.state === "provisioning") {
    await sleep(500);
    v = await getLane(repo, branch);
  }
  if (v.lane.state === "failed") die("lane provisioning failed: " + v.lane.error);
  if (ensured.created) log(`  provisioned ${v.lane.deploymentName} in ${secs(Date.now() - t0)}`);
  if (v.lane.headSha && v.lane.deployedSha !== v.lane.headSha) {
    if (v.lane.deploying) {
      log(`  ${v.lane.deploying.holder} is deploying ${short(v.lane.deploying.sha)}; waiting`);
      await waitFor(repo, branch, v.lane.headSha);
    } else if ((await deploy(repo, branch)) === false) {
      die("the lane is up but its deploy failed; see the error above");
    }
    v = await getLane(repo, branch);
  }
  writeEnv(v.lane);
  if (!quiet) {
    log(`Lane ready in ${secs(Date.now() - t0)}`);
    log(`  convex   ${v.lane.deploymentUrl}`);
    log(`  deployed ${short(v.lane.deployedSha)} (branch HEAD ${short(v.lane.headSha)})`);
    log(`  page     ${pageUrl(repo, branch)}`);
    log(`  wrote .env.local`);
  }
  return { repo, branch, view: v };
}

function writeEnv(lane) {
  if (!repoRoot || args["no-env"]) return;
  const p = path.join(repoRoot, ".env.local");
  const keep = fs.existsSync(p)
    ? fs.readFileSync(p, "utf8").split("\n").filter((l) => l && !/^(CONVEX_URL|CONVEX_SITE_URL|VITE_CONVEX_URL|NEXT_PUBLIC_CONVEX_URL|LANE_[A-Z_]+)=/.test(l))
    : [];
  const lines = [
    ...keep,
    `CONVEX_URL=${lane.deploymentUrl}`,
    `CONVEX_SITE_URL=${lane.siteUrl}`,
    `VITE_CONVEX_URL=${lane.deploymentUrl}`,
    `NEXT_PUBLIC_CONVEX_URL=${lane.deploymentUrl}`,
    `LANE_DEPLOYMENT=${lane.deploymentName}`,
    `LANE_PAGE=${pageUrl(lane.repo, lane.branch)}`,
  ];
  fs.writeFileSync(p, lines.join("\n") + "\n");
}

async function join() {
  const task = args.task;
  if (!task || task === true) die('join needs --task "what this agent is doing"');
  const { repo, branch, view } = await up({ quiet: true });
  const id = detectAgent();
  const prev = readState("agent.json");
  const res = await api("POST", "/api/agents/join", {
    repo,
    branch,
    task,
    vendor: id.vendor,
    machine: id.machine,
    threadUrl: typeof args.thread === "string" ? args.thread : id.threadUrl,
    person: process.env.LANE_PERSON,
    agentId: prev && prev.repo === repo && prev.branch === branch ? prev.agentId : undefined,
  });
  writeState("agent.json", { agentId: res.agentId, repo, branch });
  const others = view.agents.filter((a) => a.id !== res.agentId && a.status !== "done");
  if (args.json) return console.log(JSON.stringify({ agentId: res.agentId, lane: view.lane, others }, null, 2));
  log(`Joined ${repo}@${branch} as ${id.vendor} (${id.machine})${id.threadUrl ? " · " + id.threadUrl : ""}`);
  log(`  convex ${view.lane.deploymentUrl} · deployed ${short(view.lane.deployedSha)}`);
  log(`  page   ${pageUrl(repo, branch)}`);
  if (others.length) {
    log(`  Also on this lane:`);
    for (const a of others) log(`   - ${a.vendor}/${a.person}: ${a.task} [${a.status}]`);
  } else log(`  You're the only agent on this lane.`);
}

async function heartbeat(status) {
  const st = readState("agent.json");
  if (!st) die("not joined; run lane join first");
  await api("POST", "/api/agents/heartbeat", {
    agentId: st.agentId,
    status: status || (typeof args.status === "string" ? args.status : "working"),
    task: typeof args.task === "string" ? args.task : undefined,
    lastSha: git(["rev-parse", "HEAD"]) || undefined,
  });
}

async function status() {
  const repo = repoId();
  const branch = branchName();
  const v = await getLane(repo, branch);
  if (args.json) return console.log(JSON.stringify(v, null, 2));
  const l = v.lane;
  console.log(`${l.repo}@${l.branch}  [${l.state}]`);
  console.log(`  convex    ${l.deploymentUrl ?? "-"}  (${l.deploymentName ?? "-"})`);
  console.log(`  deployed  ${short(l.deployedSha)}   HEAD ${short(l.headSha)}${l.deploying ? `   deploying ${short(l.deploying.sha)} (${l.deploying.holder})` : ""}`);
  if (l.error) console.log(`  error     ${l.error.split("\n")[0]}`);
  console.log(`  page      ${pageUrl(repo, branch)}`);
  console.log(`  agents:`);
  for (const a of v.agents) console.log(`   - ${a.vendor}/${a.person} [${a.status}] ${a.task}${a.threadUrl ? "  " + a.threadUrl : ""}`);
  console.log(`  recent:`);
  for (const e of v.events.slice(0, 8)) console.log(`   ${new Date(e.at).toISOString().slice(11, 19)} ${e.type.padEnd(13)} ${e.actor}: ${e.detail}`);
}

async function list() {
  const lanes = await api("GET", "/api/lanes");
  if (args.json) return console.log(JSON.stringify(lanes, null, 2));
  for (const l of lanes) {
    console.log(`${l.state.padEnd(12)} ${(l.repo + "@" + l.branch).padEnd(40)} agents ${l.activeAgents}/${l.totalAgents}  deployed ${short(l.deployedSha)}`);
  }
}

async function waitFor(repo, branch, sha, timeoutMs = 10 * 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { lane } = await getLane(repo, branch);
    if (lane.deployedSha && (lane.deployedSha === sha || isAncestor(sha, lane.deployedSha))) {
      log(`${short(sha)} is live on ${branch} (waited ${secs(Date.now() - t0)})`);
      return lane;
    }
    if (!lane.deploying && lane.error && lane.headSha === sha) die(`deploy of ${short(sha)} failed: ${lane.error.split("\n")[0]}`);
    await sleep(1000);
  }
  die(`timed out waiting for ${short(sha)}`);
}

// The serialized deployer. Always deploys what's pushed to the branch, never a working tree.
async function deploy(repo, branch) {
  const holder = `${process.env.LANE_DEPLOYER || detectAgent().vendor + "@" + os.hostname()}#${process.pid}`;
  for (let round = 0; round < 10; round++) {
    const claim = await api("POST", "/api/deploy/claim", { repo, branch, holder, force: round === 0 && !!args.force });
    if (claim.status === "busy") {
      log(`  deploy lock held by ${claim.holder} (${short(claim.sha)}); it will pick up the newest HEAD`);
      return;
    }
    if (claim.status !== "claimed") {
      log(`  nothing to deploy (${claim.status}${claim.sha ? " " + short(claim.sha) : ""})`);
      return;
    }
    const sha = claim.sha;
    const t0 = Date.now();
    log(`  deploying ${short(sha)} to ${branch}...`);
    let ok = false;
    let seeded = false;
    let detail = "";
    let wt;
    try {
      wt = checkout(sha, branch);
      const env = { ...process.env, CONVEX_DEPLOY_KEY: claim.deployKey };
      delete env.CONVEX_DEPLOYMENT;
      const tDeploy = Date.now();
      run("npx", ["convex", "deploy", "-y"], wt, env);
      detail = `deploy ${secs(Date.now() - tDeploy)}`;
      if (claim.seedFunction) {
        const tSeed = Date.now();
        run("npx", ["convex", "run", claim.seedFunction], wt, env);
        seeded = true;
        detail += `, seed ${secs(Date.now() - tSeed)}`;
      }
      ok = true;
      detail += `, total ${secs(Date.now() - t0)}`;
    } catch (e) {
      detail = String(e.message || e).slice(-1500);
    } finally {
      if (wt) {
        try {
          execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: gitDir, stdio: "ignore" });
        } catch {}
      }
    }
    const fin = await api("POST", "/api/deploy/finish", { repo, branch, holder, sha, ok, seeded, detail });
    log(ok ? `  ${short(sha)} live (${detail})` : `  deploy of ${short(sha)} failed:\n${detail}`);
    if (!ok) {
      process.exitCode = 1;
      return false;
    }
    if (!fin.again) return true;
    log(`  branch moved during deploy; deploying newest HEAD`);
  }
}

function run(bin, argv, cwd, env) {
  try {
    execFileSync(bin, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 << 20 });
  } catch (e) {
    throw new Error(`${bin} ${argv.join(" ")} failed:\n${(e.stdout || "") + (e.stderr || "")}`);
  }
}

// A clean worktree at exactly `sha`, with node_modules shared by lockfile hash.
function checkout(sha, branch) {
  if (!git(["cat-file", "-e", sha + "^{commit}"])) git(["fetch", "--quiet", "origin", branch]);
  const cache = path.join(os.homedir(), ".cache/lane");
  const wt = path.join(cache, "wt", `${sha.slice(0, 12)}-${process.pid}`);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  execFileSync("git", ["worktree", "add", "--detach", "--force", wt, sha], { cwd: gitDir, stdio: "ignore" });
  const lock = ["package-lock.json", "package.json"].map((f) => path.join(wt, f)).find((f) => fs.existsSync(f));
  if (lock) {
    const hash = createHash("sha256").update(fs.readFileSync(lock)).digest("hex").slice(0, 16);
    const nm = path.join(cache, "node_modules", hash);
    if (!fs.existsSync(path.join(nm, "node_modules"))) {
      const tmp = nm + ".tmp-" + process.pid;
      fs.mkdirSync(tmp, { recursive: true });
      for (const f of ["package.json", "package-lock.json"]) {
        if (fs.existsSync(path.join(wt, f))) fs.copyFileSync(path.join(wt, f), path.join(tmp, f));
      }
      const hasLock = fs.existsSync(path.join(tmp, "package-lock.json"));
      run("npm", [hasLock ? "ci" : "install", "--no-audit", "--no-fund", "--silent"], tmp, process.env);
      try {
        fs.renameSync(tmp, nm);
      } catch {
        fs.rmSync(tmp, { recursive: true, force: true }); // another deployer won the race
      }
    }
    fs.symlinkSync(path.join(nm, "node_modules"), path.join(wt, "node_modules"));
  }
  return wt;
}

async function key() {
  const repo = repoId();
  const branch = branchName();
  const holder = process.env.LANE_PERSON ? `${detectAgent().vendor}/${process.env.LANE_PERSON}` : detectAgent().vendor;
  const res = await api("POST", "/api/lane/key", { repo, branch, holder });
  if (args.print) return console.log(res.key);
  writeState("deploy-key", res.key + "\n", 0o600);
  log(`Deploy key for ${branch} saved to ${path.join(stateDir, "deploy-key")} (expires ${new Date(res.expiresAt).toISOString()})`);
  log(`Use it with: CONVEX_DEPLOY_KEY=$(cat .lane/deploy-key) npx convex run <fn>`);
}

async function down() {
  const repo = repoId();
  const branch = branchName();
  const res = await api("POST", "/api/lane/down", { repo, branch, reason: typeof args.reason === "string" ? args.reason : "lane down" });
  if (res.alreadyDown) log(`${branch}: already archived`);
  else log(`${branch}: archived; keys revoked; deployment deleted in ${Math.round(res.graceMs / 1000)}s`);
}

// Git post-receive hook. Stdin: "<old> <new> <ref>" per updated ref.
async function postReceive() {
  const repo = repoId();
  const input = fs.readFileSync(0, "utf8").trim();
  const ZERO = /^0+$/;
  for (const line of input.split("\n").filter(Boolean)) {
    const [oldSha, newSha, ref] = line.split(" ");
    if (!ref.startsWith("refs/heads/")) continue;
    const branch = ref.slice("refs/heads/".length);
    if (ZERO.test(newSha)) {
      await api("POST", "/api/lane/down", { repo, branch, reason: "branch deleted" }).catch(() => {});
      continue;
    }
    const changed = ZERO.test(oldSha) ? ["convex/"] : (git(["diff", "--name-only", oldSha, newSha, "--", "convex/"]) || "").split("\n").filter(Boolean);
    const res = await api("POST", "/api/lane/push", {
      repo,
      branch,
      sha: newSha,
      convexChanged: changed.length > 0,
      actor: process.env.LANE_PUSHER || process.env.USER || "git",
    });
    if (!res.lane) continue;
    console.log(`lane: ${branch} -> ${short(newSha)} ${res.deployNeeded ? "(deploying in background)" : "(convex/ unchanged, no deploy)"}`);
    if (res.deployNeeded) {
      // Like the GitHub Action deployer: detached, so the push returns at once.
      const logFile = path.join(gitDir, `lane-deploy-${branch.replace(/\W+/g, "-")}.log`);
      const out = fs.openSync(logFile, "a");
      const child = spawn(process.execPath, [process.argv[1], "deploy", "--repo", repo, "--branch", branch], {
        cwd: gitDir,
        detached: true,
        stdio: ["ignore", out, out],
        env: { ...process.env, GIT_DIR: gitDir, LANE_DEPLOYER: process.env.LANE_DEPLOYER || "git-hook" },
      });
      child.unref();
    }
  }
}

// ---------------------------------------------------------------- main

const commands = {
  up: () => up(),
  join,
  status,
  list,
  wait: async () => {
    const repo = repoId();
    const branch = branchName();
    const sha = typeof args.sha === "string" ? git(["rev-parse", args.sha]) || args.sha : remoteHead(branch);
    await waitFor(repo, branch, sha, Number(args.timeout || 600) * 1000);
  },
  deploy: () => deploy(repoId(), branchName()),
  key,
  heartbeat: () => heartbeat(),
  leave: () => heartbeat("done"),
  down,
  page: async () => console.log(pageUrl(repoId(), branchName())),
  hook: async () => {
    if (args._[1] !== "post-receive") die("usage: lane hook post-receive");
    await postReceive();
  },
};

if (!cmd || cmd === "help" || args.help) {
  console.log(HELP);
} else if (!commands[cmd]) {
  die(`unknown command "${cmd}"\n\n${HELP}`);
} else {
  commands[cmd]().catch((e) => die(e.message));
}
