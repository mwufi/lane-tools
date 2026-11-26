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

  login [--url <url>] [--print]      Sign in with GitHub; saves your lane token (--print: for cloud envs)
  init --url <url> [--token-stdin]   Set up with a token you already have (no repo changes)
  doctor [--url <url>]    Check node, URL, token, network and whether this repo is registered
  run <fn> [json args]    Run a Convex function on this branch's lane, e.g. lane run seed:run '{"n":5}' 
  push [git args]         git push, then redeploy the lane if convex/ changed and wait until live
  up                      Create or reuse this branch's lane, deploy the pushed HEAD, write .env.local
  join --task "..."       up, then register this agent on the lane page (vendor/thread auto-detected)
  status [--json]         Lane state, URLs, deployed vs HEAD, other agents and recent activity
  list                    All lanes
  wait [--sha <sha>]      Block until <sha> (default: origin HEAD) is live on the lane
  deploy                  Deploy the branch's pushed HEAD under the lane lock (what CI/hooks run)
  reset --table <t>[,<t>] Empty those tables on this lane (e.g. old rows blocking a schema change)
  reset --snapshot        Replace all of this lane's data with the repo's newest seed snapshot
  key [--print]           Mint a 4h deploy key for this lane (saved to .lane/deploy-key)
  heartbeat [--status working|waiting|done] [--task "..."]
  leave                   Mark this agent done
  env NAME=value ...      Set allow-listed env vars on this lane (e.g. SITE_URL of the branch preview)
  down                    Archive the lane: revoke keys now, delete the deployment after grace
  page                    Print the lane page URL
  pool [fill [--sha <sha>]]  Show the repo's warm spares; fill deploys <sha> (default HEAD) to them
  pr-status [--pr N]      Post or update the lane status comment on the branch's PR (needs GITHUB_TOKEN)
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
const CONFIG_DIR = path.join(os.homedir(), ".config/lane");
function readJson(p) {
  try {
    return p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  } catch {
    return {};
  }
}
// Personal config (~/.config/lane/config.json) first, then an optional committed .lane.json.
const fileCfg = { ...readJson(path.join(CONFIG_DIR, "config.json")), ...readJson(repoRoot && path.join(repoRoot, ".lane.json")) };

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
  if (ensured.warm) log(`  claimed warm spare ${v.lane.deploymentName} (seeded, running ${short(v.lane.deployedSha)})`);
  else if (ensured.created) log(`  provisioned ${v.lane.deploymentName} in ${secs(Date.now() - t0)}`);
  excludeLocalFiles();
  if (headSha && v.lane.headSha && v.lane.headSha !== headSha) {
    // Someone did a plain `git push`: catch the lane up to what's on the branch now.
    await reportPush(repo, branch, v.lane.headSha, headSha);
    v = await getLane(repo, branch);
  }
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

// Keep lane's local files out of `git status` without touching the repo's .gitignore.
function excludeLocalFiles() {
  if (!gitDir || !repoRoot) return;
  const p = path.join(gitDir, "info", "exclude");
  const have = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const missing = [".lane/", ".env.local"].filter((l) => !have.split("\n").includes(l));
  if (!missing.length) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, (have && !have.endsWith("\n") ? "\n" : "") + "# lane\n" + missing.join("\n") + "\n");
}

// Tell lane-control the branch moved. convex/ unchanged -> no deploy needed.
async function reportPush(repo, branch, oldSha, newSha) {
  let convexChanged = true;
  if (oldSha && git(["cat-file", "-e", oldSha + "^{commit}"]) !== null) {
    const diff = git(["diff", "--name-only", oldSha, newSha, "--", "convex/"]);
    if (diff !== null) convexChanged = diff.length > 0;
  }
  const me = readState("agent.json");
  const actor = me?.name || `${detectAgent().vendor}/${process.env.LANE_PERSON || os.userInfo().username}`;
  return await api("POST", "/api/lane/push", { repo, branch, sha: newSha, convexChanged, actor });
}

// git push, then make the lane follow it and wait until it's live. Replaces the CI deployer.
async function push() {
  const repo = repoId();
  const branch = branchName();
  const t0 = Date.now();
  const before = git(["rev-parse", `refs/remotes/origin/${branch}`]);
  const hasUpstream = git(["rev-parse", "--abbrev-ref", "@{u}"]) !== null;
  const extra = args._.slice(1);
  try {
    execFileSync("git", ["push", ...(hasUpstream ? [] : ["-u", "origin", branch]), ...extra], { stdio: "inherit" });
  } catch {
    die("git push failed");
  }
  const sha = git(["rev-parse", "HEAD"]);
  let view;
  try {
    view = await getLane(repo, branch);
  } catch (e) {
    if (e.status === 404) {
      log(`Pushed. No lane for ${branch} yet; run \`lane join --task "..."\` to start one.`);
      return;
    }
    throw e;
  }
  if (["archived", "deleted"].includes(view.lane.state)) {
    log(`Pushed. The lane for ${branch} is ${view.lane.state}; run \`lane join\` to bring it back.`);
    return;
  }
  const res = await reportPush(repo, branch, view.lane.headSha || before, sha);
  if (!res.deployNeeded) {
    log(`${short(sha)} is live on ${branch} (convex/ unchanged, no deploy) in ${secs(Date.now() - t0)}`);
  } else {
    if ((await deploy(repo, branch)) === false) die(`deploy of ${short(sha)} failed; the lane still runs ${short(view.lane.deployedSha)}`);
    await waitFor(repo, branch, sha);
  }
  if (readState("agent.json")) await heartbeat("working").catch(() => {});
}

// Sign in with GitHub (device flow): no secrets on this machine except the resulting lane token.
async function login() {
  const url = (typeof args.url === "string" ? args.url : LANE_URL).replace(/\/$/, "");
  if (!url) die("pass --url https://<your lane-control>.convex.site the first time");
  if (!args.print) {
    // Remember the control plane even if sign-in fails, so `lane doctor` and `lane init` know it.
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const cfgPath = path.join(CONFIG_DIR, "config.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ ...readJson(cfgPath), url }, null, 2) + "\n");
  }
  const cfg = await (await fetch(url + "/api/auth/config")).json();
  const tokenPath = `or skip GitHub: an admin mints a token at ${url}/admin (Tokens), then set LANE_URL=${url} and LANE_TOKEN (or run lane init --url ${url} --token-stdin < token-file)`;
  if (!cfg.githubClientId) die(`GitHub login isn't set up on this lane-control yet; ${tokenPath}`);
  const form = (o) => new URLSearchParams(o).toString();
  const gh = async (p, body) => {
    const r = await fetch("https://github.com" + p, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: form(body),
    });
    return await r.json();
  };
  const dc = await gh("/login/device/code", { client_id: cfg.githubClientId, scope: "read:org" });
  if (!dc.device_code) die("GitHub refused the login request: " + (dc.error_description || dc.error || "unknown error") + ".\n" +
    (cfg.githubAppSettings ? `An admin can tick "Enable Device Flow" at ${cfg.githubAppSettings}, ` : "An admin can enable Device Flow on the GitHub app, ") + tokenPath);
  console.error(`\nOpen ${dc.verification_uri} and enter this code:\n\n    ${dc.user_code}\n`);
  if (!args["no-browser"]) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try { spawn(opener, [dc.verification_uri], { stdio: "ignore", detached: true }).unref(); } catch {}
  }
  let interval = (dc.interval || 5) * 1000;
  const deadline = Date.now() + (dc.expires_in || 900) * 1000;
  let accessToken = null;
  while (!accessToken && Date.now() < deadline) {
    await sleep(interval);
    const r = await gh("/login/oauth/access_token", {
      client_id: cfg.githubClientId,
      device_code: dc.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (r.access_token) accessToken = r.access_token;
    else if (r.error === "slow_down") interval += 5000;
    else if (r.error !== "authorization_pending") die("GitHub login failed: " + (r.error_description || r.error));
  }
  if (!accessToken) die("timed out waiting for you to approve on GitHub");
  const res = await fetch(url + "/api/auth/github", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessToken }),
  });
  const j = await res.json();
  if (!res.ok) die(j.error || `login failed (${res.status})`);
  if (args.print) {
    // For cloud agent environments: paste this as LANE_TOKEN in the vendor's secrets.
    console.log(j.token);
    console.error(`Signed in as ${j.person}. The token above is for a cloud environment's LANE_TOKEN; keep it secret.`);
    return;
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const cfgPath = path.join(CONFIG_DIR, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ ...readJson(cfgPath), url }, null, 2) + "\n");
  fs.writeFileSync(path.join(CONFIG_DIR, "token"), j.token + "\n", { mode: 0o600 });
  console.error(`Signed in as ${j.person}. Saved to ~/.config/lane/. Try: lane list`);
}

// One-time personal setup: control plane URL + token, no repo changes.
async function init() {
  const url = typeof args.url === "string" ? args.url.replace(/\/$/, "") : LANE_URL;
  if (!url) die("pass --url https://<your lane-control>.convex.site");
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const cfgPath = path.join(CONFIG_DIR, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ ...readJson(cfgPath), url }, null, 2) + "\n");
  let token = process.env.LANE_TOKEN || "";
  if (args["token-stdin"]) token = fs.readFileSync(0, "utf8").trim();
  if (token) fs.writeFileSync(path.join(CONFIG_DIR, "token"), token + "\n", { mode: 0o600 });
  log(`Saved ${cfgPath}${token ? " and ~/.config/lane/token" : ""}`);
  excludeLocalFiles();
  await doctor({ url, token: token || LANE_TOKEN });
}

async function doctor(over = {}) {
  const url = over.url || LANE_URL;
  const token = over.token || LANE_TOKEN;
  let ok = true;
  const check = (good, label, hint) => {
    console.log(`${good ? "ok  " : "FAIL"} ${label}${!good && hint ? "\n     -> " + hint : ""}`);
    ok &&= good;
    return good;
  };
  check(Number(process.versions.node.split(".")[0]) >= 22, `node ${process.versions.node}`, "install Node 22 or newer");
  if (!check(!!url, `control plane ${url || "(unset)"}`, "lane init --url https://<lane-control>.convex.site")) return process.exit(1);
  if (!check(!!token, "token present", "set LANE_TOKEN, or: lane init --token-stdin < token-file")) return process.exit(1);
  let who = null;
  try {
    const r = await fetch(url + "/api/whoami", { headers: { authorization: "Bearer " + token } });
    who = r.ok ? (await r.json()).person : null;
    check(!!who, who ? `signed in as ${who}` : `token rejected (${r.status})`, "ask a lane admin for a new token");
  } catch (e) {
    check(false, `can't reach ${url}: ${e.message}`, "allow *.convex.site (and *.convex.cloud, api.convex.dev) in this environment's network policy");
  }
  if (repoRoot) {
    const repo = repoId();
    try {
      const r = await fetch(`${url}/api/repo?repo=${encodeURIComponent(repo)}`, { headers: { authorization: "Bearer " + token } });
      const j = await r.json();
      check(!!j.registered, `repo ${repo} ${j.registered ? "is registered for lanes" : "is NOT registered"}`, "a lane admin runs: npx convex run admin:registerRepo (see lane-tools README)");
    } catch {}
    const b = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    console.log(`     branch ${b}${b === "main" || b === "master" ? " (lanes are for feature branches)" : ""}`);
  } else console.log("     not inside a git repo; repo checks skipped");
  console.log(ok ? "lane is ready." : "fix the FAIL lines above.");
  if (!ok) process.exitCode = 1;
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
  writeState("agent.json", { agentId: res.agentId, name: res.name, repo, branch });
  const others = view.agents.filter((a) => a.id !== res.agentId && a.status !== "done");
  if (args.json) return console.log(JSON.stringify({ agentId: res.agentId, lane: view.lane, others }, null, 2));
  log(`Joined ${repo}@${branch} as ${res.name} (${id.vendor}, ${id.machine})${id.threadUrl ? " · " + id.threadUrl : ""}`);
  log(`  convex ${view.lane.deploymentUrl} · deployed ${short(view.lane.deployedSha)}`);
  log(`  page   ${pageUrl(repo, branch)}`);
  if (others.length) {
    log(`  Also on this lane:`);
    for (const a of others) log(`   - ${a.name || a.vendor} (${a.vendor}, ${a.person}): ${a.task} [${a.status}]`);
  } else log(`  You're the only agent on this lane.`);
  if (!view.lane.headSha) log(`  ${branch} isn't pushed yet; \`lane push\` deploys it to the lane.`);
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
  for (const a of v.agents) console.log(`   - ${a.name || a.vendor} (${a.vendor}, ${a.person}) [${a.status}] ${a.task}${a.threadUrl ? "  " + a.threadUrl : ""}`);
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
  const holder = `${process.env.LANE_DEPLOYER || readState("agent.json")?.name || detectAgent().vendor + "@" + os.hostname()}#${process.pid}`;
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
      // Fast path: this checkout is exactly the pushed commit, so deploy it in place with its
      // node_modules. Otherwise use a clean worktree at that commit.
      const inPlace = cleanCheckoutAt(sha);
      const dir = inPlace ? repoRoot : (wt = checkout(sha, branch));
      const env = { ...process.env, CONVEX_DEPLOY_KEY: claim.deployKey };
      delete env.CONVEX_DEPLOYMENT;
      const tDeploy = Date.now();
      run("npx", ["convex", "deploy", "-y", ...(claim.deployArgs || [])], dir, env);
      detail = `deploy ${secs(Date.now() - tDeploy)}`;
      const setup = claim.setupFunctions || (claim.seedFunction ? [claim.seedFunction] : []);
      // A first deploy imports the repo's seed snapshot when there is one, instead of running
      // every setup function. `lane pool fill` instead re-seeds from scratch when convex/ has
      // changed since the snapshot, then exports a fresh one for everyone after it.
      const tree = git(["rev-parse", `${sha}:convex`], { cwd: dir });
      // The first lane of a repo makes its first snapshot; after that only the pool filler
      // refreshes it (once per run), when convex/ differs from what the snapshot was seeded from.
      const refresh = !!(claim.needSeed && claim.seedKey && (!claim.snapshot ||
        (snapshotFill && !snapshotFill.done && tree && claim.snapshot.tree !== tree)));
      let imported = false;
      if (claim.needSeed && claim.snapshot && claim.seedKey && !refresh) {
        const tImport = Date.now();
        try {
          await importSnapshot(claim.snapshot, claim.seedKey, dir);
          imported = seeded = true;
          detail += `, seed snapshot ${short(claim.snapshot.sha)} imported ${secs(Date.now() - tImport)}`;
        } catch (e) {
          log(`  seed snapshot import failed, running the setup functions instead: ${String(e.message || e).split("\n").slice(-3).join(" ")}`);
        }
      }
      if (!imported && setup.length) {
        const tSeed = Date.now();
        const url = (await getLane(repo, branch)).lane.deploymentUrl;
        const slow = [];
        for (const fn of setup) {
          const t = Date.now();
          if (!(url && (await callFunction(url, claim.deployKey, fn)))) run("npx", ["convex", "run", fn], dir, env);
          slow.push(`${fn} ${secs(Date.now() - t)}`);
        }
        seeded = true;
        detail += `, setup (${setup.length} fn) ${secs(Date.now() - tSeed)}`;
        if (setup.length > 1) log(`  setup: ${slow.join(", ")}`);
        if (refresh) {
          try {
            const tExport = Date.now();
            await exportSnapshot(repo, sha, tree, claim.seedKey, dir);
            if (snapshotFill) snapshotFill.done = true;
            log(`  exported a fresh seed snapshot in ${secs(Date.now() - tExport)}`);
          } catch (e) {
            log(`  couldn't export a seed snapshot (lanes keep running setup functions): ${String(e.message || e).split("\n").slice(-3).join(" ")}`);
          }
        }
      }
      // `convex deploy` regenerates convex/_generated; don't leave that diff in someone's checkout.
      if (inPlace) git(["checkout", "--", "convex/_generated"], { cwd: repoRoot });
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

// ---------------------------------------------------------------- seed snapshots

let snapshotFill = null; // set by `lane pool fill`: { done } once it has exported a fresh snapshot

async function importSnapshot(snap, seedKey, dir) {
  const res = await fetch(snap.url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const tmp = path.join(os.tmpdir(), `lane-seed-${process.pid}-${Date.now()}.zip`);
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  try {
    const env = { ...process.env, CONVEX_DEPLOY_KEY: seedKey };
    delete env.CONVEX_DEPLOYMENT;
    run("npx", ["convex", "import", "--replace-all", "-y", tmp], dir, env);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function exportSnapshot(repo, sha, tree, seedKey, dir) {
  const tmp = path.join(os.tmpdir(), `lane-seed-${process.pid}-${Date.now()}.zip`);
  try {
    const env = { ...process.env, CONVEX_DEPLOY_KEY: seedKey };
    delete env.CONVEX_DEPLOYMENT;
    run("npx", ["convex", "export", "--include-file-storage", "--path", tmp], dir, env);
    const { url } = await api("POST", "/api/seed/upload-url", {});
    const up = await fetch(url, { method: "POST", headers: { "Content-Type": "application/zip" }, body: fs.readFileSync(tmp) });
    if (!up.ok) throw new Error(`upload failed: ${up.status} ${await up.text()}`);
    const { storageId } = await up.json();
    await api("POST", "/api/seed/snapshot", { repo, sha, tree: tree || undefined, storageId });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Run one setup function the way `npx convex run` does (POST /api/function with the deploy
// key as admin auth), without starting the Convex CLI each time: that start-up dominated
// repos with many setup functions. Returns false when the CLI should do it instead.
async function callFunction(deploymentUrl, deployKey, fn, fnArgs = {}) {
  if (!/^[\w/.-]+:[\w]+$/.test(fn)) return false; // e.g. "seed" or args: leave to the CLI
  let res;
  try {
    res = await fetch(deploymentUrl.replace(/\/$/, "") + "/api/function", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Convex ${deployKey}` },
      body: JSON.stringify({ path: fn, args: fnArgs, format: "convex_encoded_json" }),
    });
  } catch {
    return false;
  }
  if (!res.ok && res.status !== 560) return false;
  const out = await res.json().catch(() => null);
  if (!out) return false;
  if (out.status === "success") return { value: out.value };
  throw new Error(`${fn} failed: ${out.errorMessage || JSON.stringify(out).slice(0, 500)}`);
}

function run(bin, argv, cwd, env) {
  try {
    execFileSync(bin, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 << 20 });
  } catch (e) {
    throw new Error(`${bin} ${argv.join(" ")} failed:\n${(e.stdout || "") + (e.stderr || "")}`);
  }
}

function cleanCheckoutAt(sha) {
  if (!repoRoot || git(["rev-parse", "HEAD"]) !== sha) return false;
  if (!fs.existsSync(path.join(repoRoot, "node_modules"))) return false;
  // Anything uncommitted under convex/ or in package files would leak into the deploy.
  const dirty = git(["status", "--porcelain", "--untracked-files=all", "--", "convex", "package.json", "package-lock.json"]);
  return dirty === "";
}

// The checkout's node_modules fits a deploy of `sha` when it was installed from the same package
// files, and (for npm workspaces, whose packages it links to) the workspace folders match `sha` too.
function reusableNodeModules(wt, sha, pkg) {
  if (!repoRoot || !fs.existsSync(path.join(repoRoot, "node_modules"))) return false;
  for (const f of ["package.json", "package-lock.json"]) {
    const a = path.join(wt, f);
    const b = path.join(repoRoot, f);
    if (fs.existsSync(a) !== fs.existsSync(b)) return false;
    if (fs.existsSync(a) && !fs.readFileSync(a).equals(fs.readFileSync(b))) return false;
  }
  const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages || [];
  if (!ws.length) return true;
  const diff = git(["diff", "--name-only", sha, "--", ...ws]);
  return diff === "";
}

// A clean worktree at exactly `sha`. node_modules comes from this checkout when it matches, else
// a cache shared by lockfile hash, else (install scripts or workspaces) a fresh install there.
function checkout(sha, branch) {
  if (!git(["cat-file", "-e", sha + "^{commit}"])) git(["fetch", "--quiet", "origin", branch]);
  const cache = path.join(os.homedir(), ".cache/lane");
  const wt = path.join(cache, "wt", `${sha.slice(0, 12)}-${process.pid}`);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  execFileSync("git", ["worktree", "add", "--detach", "--force", wt, sha], { cwd: gitDir, stdio: "ignore" });
  const lock = ["package-lock.json", "package.json"].map((f) => path.join(wt, f)).find((f) => fs.existsSync(f));
  if (!lock) return wt;
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(wt, "package.json"), "utf8"));
  } catch {}
  if (reusableNodeModules(wt, sha, pkg)) {
    // This checkout installed exactly these dependencies, with its own install scripts: reuse them.
    fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(wt, "node_modules"));
    return wt;
  }
  const scripts = pkg.scripts || {};
  if (pkg.workspaces || ["preinstall", "install", "postinstall", "prepare"].some((s) => scripts[s])) {
    // Install scripts read the repo's files, and workspaces link into it: install in the worktree.
    run("npm", [fs.existsSync(path.join(wt, "package-lock.json")) ? "ci" : "install", "--no-audit", "--no-fund", "--silent"], wt, process.env);
    return wt;
  }
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
  return wt;
}

// `lane deploy`: catch the lane up to a plain `git push` it hasn't heard about, then deploy.
async function deployCmd() {
  const repo = repoId();
  const branch = branchName();
  const head = remoteHead(branch);
  const v = await getLane(repo, branch);
  if (head && v.lane.headSha && head !== v.lane.headSha && !isAncestor(head, v.lane.headSha)) {
    log(`  the lane last saw ${short(v.lane.headSha)}; recording ${short(head)}, pushed since`);
    await reportPush(repo, branch, v.lane.headSha, head);
  }
  if ((await deploy(repo, branch)) === false) process.exitCode = 1;
}

// Wipe lane data the lane's own keys can't: they run functions but can't import or replace.
async function reset() {
  const repo = repoId();
  const branch = branchName();
  const tables = typeof args.table === "string" ? args.table.split(",").map((t) => t.trim()).filter(Boolean) : [];
  if (!tables.length && !args.snapshot) die("usage: lane reset --table <name>[,<name>]  or  lane reset --snapshot");
  if (tables.some((t) => !/^[A-Za-z][\w]*$/.test(t))) die(`not a table name: ${tables.join(", ")}`);
  const holder = readState("agent.json")?.name || detectAgent().vendor;
  const detail = tables.length ? `emptied ${tables.join(", ")}` : "restored the seed snapshot";
  const v = await getLane(repo, branch);
  const res = await api("POST", "/api/lane/reset-key", { repo, branch, holder, detail });
  const env = { ...process.env, CONVEX_DEPLOY_KEY: res.key };
  delete env.CONVEX_DEPLOYMENT;
  const dir = repoRoot || process.cwd();
  if (tables.length) {
    const empty = path.join(os.tmpdir(), `lane-empty-${process.pid}.jsonl`);
    fs.writeFileSync(empty, "");
    try {
      for (const t of tables) {
        run("npx", ["convex", "import", "--table", t, "--replace", "-y", empty], dir, env);
        log(`  emptied ${t} on ${v.lane.deploymentName}`);
      }
    } finally {
      fs.rmSync(empty, { force: true });
    }
    return;
  }
  if (!res.snapshot) die("this repo has no seed snapshot yet; empty specific tables with --table instead");
  await importSnapshot(res.snapshot, res.key, dir);
  log(`  ${v.lane.deploymentName} now holds seed snapshot ${short(res.snapshot.sha)}`);
}

async function key() {
  const repo = repoId();
  const branch = branchName();
  const holder = process.env.LANE_PERSON ? `${detectAgent().vendor}/${process.env.LANE_PERSON}` : detectAgent().vendor;
  const res = await api("POST", "/api/lane/key", { repo, branch, holder });
  if (args.print) return console.log(res.key);
  writeState("deploy-key", res.key + "\n", 0o600);
  log(`Deploy key for ${branch} saved to ${path.join(stateDir, "deploy-key")} (expires ${new Date(res.expiresAt).toISOString()})`);
  log(`Use it with: CONVEX_DEPLOY_KEY=$(cat .lane/deploy-key) npx convex <command>  (to run a function: lane run <fn>)`);
}

// One step instead of `lane key` + `CONVEX_DEPLOY_KEY=... npx convex run`: mints a short
// lane key and runs the function on this branch's lane. Prints the result as JSON.
async function runFn() {
  const repo = repoId();
  const branch = branchName();
  const fn = args._[1];
  if (!fn || !/^[\w/.-]+:[\w]+$/.test(fn)) die('usage: lane run <module:function> [json args], e.g. lane run seed:run \'{"n":5}\'');
  let fnArgs = {};
  if (args._[2] !== undefined) {
    try {
      fnArgs = JSON.parse(String(args._[2]));
    } catch {
      die(`args must be JSON, e.g. '{"n":5}' (got ${args._[2]})`);
    }
  }
  const v = await getLane(repo, branch);
  if (!v.lane.deploymentUrl || v.lane.state !== "ready") die(`${branch}'s lane is ${v.lane.state}; run lane join first`);
  const holder = process.env.LANE_PERSON ? `${detectAgent().vendor}/${process.env.LANE_PERSON}` : detectAgent().vendor;
  const { key } = await api("POST", "/api/lane/key", { repo, branch, holder });
  let res;
  try {
    res = await callFunction(v.lane.deploymentUrl, key, fn, fnArgs);
  } catch (e) {
    die(e.message);
  }
  if (!res) die(`couldn't reach ${v.lane.deploymentUrl} to run ${fn}`);
  console.log(JSON.stringify(res.value ?? null, null, 2));
}

async function env() {
  const repo = repoId();
  const branch = branchName();
  const vars = {};
  for (const pair of args._.slice(1)) {
    const i = pair.indexOf("=");
    if (i <= 0) die(`usage: lane env NAME=value ... (got "${pair}")`);
    vars[pair.slice(0, i)] = pair.slice(i + 1);
  }
  if (Object.keys(vars).length === 0) die("usage: lane env NAME=value ...");
  const res = await api("POST", "/api/lane/env", { repo, branch, vars });
  log(res.changed.length ? `${branch}: set ${res.changed.join(", ")}` : `${branch}: env already up to date`);
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

// ---------------------------------------------------------------- warm pool

// Spare lanes kept deployed from the default branch and seeded, so a new lane starts warm.
// `lane pool fill` runs in CI on pushes to the default branch: it deploys that commit to every
// spare that isn't running it (seeding new ones), under each spare's own deploy lock.
async function pool() {
  const repo = repoId();
  const sub = args._[1];
  if (sub && sub !== "fill") die("usage: lane pool [fill [--sha <sha>]]");
  const p = await api("GET", `/api/pool?repo=${encodeURIComponent(repo)}`);
  if (sub !== "fill") {
    if (args.json) return console.log(JSON.stringify(p, null, 2));
    log(`${repo}: pool size ${p.poolSize}${p.poolSize ? "" : " (off; an admin sets it in the panel)"}`);
    for (const s of p.spares) {
      const what = s.state !== "ready" ? s.state : s.deploying ? `deploying ${short(s.deploying)}` : s.seeded ? `warm at ${short(s.deployedSha)}` : "waiting for first deploy";
      log(`  ${s.branch.padEnd(16)} ${(s.deploymentName || "").padEnd(28)} ${what}${s.error ? ` (${s.error.slice(0, 80)})` : ""}`);
    }
    return;
  }
  const sha = typeof args.sha === "string" ? git(["rev-parse", args.sha]) || args.sha : git(["rev-parse", "HEAD"]);
  if (!sha) die("no commit to deploy; pass --sha");
  const todo = p.spares.filter((s) => s.state === "ready" && !(s.seeded && s.deployedSha === sha));
  if (!todo.length) return log(`pool: ${p.spares.length} spare(s), all warm at ${short(sha)}`);
  snapshotFill = { done: false };
  let failed = 0;
  for (const s of todo) {
    log(`pool: ${s.branch} (${s.deploymentName})`);
    await api("POST", "/api/lane/push", { repo, branch: s.branch, sha, convexChanged: true, actor: "lane pool fill" });
    if ((await deploy(repo, s.branch)) === false) failed++;
  }
  if (failed) die(`${failed} spare(s) failed to deploy`);
}

// ---------------------------------------------------------------- PR status comment

// One comment per PR, edited in place, saying where the branch's lane is and whether it's live.
// Runs in CI after `lane up` with GITHUB_TOKEN (pull-requests: write); `--pr N` picks the PR,
// otherwise the open PR whose head is this branch.
const PR_MARKER = "<!-- lane-status -->";

async function gh(method, p, body) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) die("GITHUB_TOKEN is not set");
  const res = await fetch(`${process.env.GITHUB_API_URL || "https://api.github.com"}${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "lane-tools" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${method} ${p} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

function prStatusBody(repo, branch, v) {
  const l = v.lane;
  const when = (t) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "");
  const state =
    l.state === "ready"
      ? l.deploying
        ? `deploying \`${short(l.deploying.sha)}\``
        : l.headSha && l.deployedSha !== l.headSha
          ? `behind: running \`${short(l.deployedSha)}\`, branch is at \`${short(l.headSha)}\``
          : `live at \`${short(l.deployedSha)}\``
      : l.state;
  const ok = l.state === "ready" && !l.deploying && (!l.headSha || l.deployedSha === l.headSha) && !l.error;
  const rows = [
    ["Status", `${ok ? "🟢" : l.state === "failed" || l.error ? "🔴" : "🟡"} ${state}`],
    ["Backend", l.deploymentUrl ? `[${l.deploymentName}](${l.dashboardUrl}) · \`${l.deploymentUrl}\`` : "being created"],
    ...(l.appUrl ? [["App", l.appUrl]] : []),
    ["Seed data", l.seeded ? "loaded" : "not yet"],
    ["Lane page", `[open](${pageUrl(repo, branch)}): agents, deploys, keys`],
  ];
  const active = v.agents.filter((a) => a.status !== "done" && a.status !== "idle");
  if (active.length) rows.push(["On this lane", active.map((a) => `${a.name || a.vendor} (${a.vendor}): ${a.task}`).join("<br>")]);
  if (l.error) rows.push(["Last error", "`" + l.error.split("\n")[0].slice(0, 200).replace(/`/g, "'") + "`"]);
  return [
    PR_MARKER,
    `### Lane for \`${branch}\``,
    "",
    "| | |",
    "| --- | --- |",
    ...rows.map(([k, val]) => `| ${k} | ${val} |`),
    "",
    `<sub>Updated ${when(Date.now())} by lane-tools. Agents: \`lane join --task "..."\` on this branch uses this backend.</sub>`,
  ].join("\n");
}

async function prStatus() {
  const repo = repoId();
  const branch = branchName();
  let pr = args.pr ? Number(args.pr) : null;
  if (!pr) {
    const [owner] = repo.split("/");
    const open = await gh("GET", `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(owner + ":" + branch)}`);
    pr = open[0]?.number ?? null;
  }
  if (!pr) return log(`no open PR for ${branch}; nothing to update`);
  let v;
  try {
    v = await getLane(repo, branch);
  } catch (e) {
    return log(`no lane for ${branch} yet; nothing to update`);
  }
  const body = prStatusBody(repo, branch, v);
  const comments = await gh("GET", `/repos/${repo}/issues/${pr}/comments?per_page=100`);
  const mine = comments.find((c) => typeof c.body === "string" && c.body.startsWith(PR_MARKER));
  if (mine) await gh("PATCH", `/repos/${repo}/issues/comments/${mine.id}`, { body });
  else await gh("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
  log(`${mine ? "updated" : "posted"} lane status on ${repo}#${pr}`);
}

// ---------------------------------------------------------------- main

const commands = {
  up: () => up(),
  login,
  push,
  init,
  doctor: () => doctor({ url: typeof args.url === "string" ? args.url.replace(/\/$/, "") : undefined }),
  join,
  status,
  list,
  wait: async () => {
    const repo = repoId();
    const branch = branchName();
    const sha = typeof args.sha === "string" ? git(["rev-parse", args.sha]) || args.sha : remoteHead(branch);
    await waitFor(repo, branch, sha, Number(args.timeout || 600) * 1000);
  },
  deploy: deployCmd,
  reset,
  key,
  run: runFn,
  heartbeat: () => heartbeat(),
  leave: () => heartbeat("done"),
  env,
  down,
  page: async () => console.log(pageUrl(repoId(), branchName())),
  pool,
  "pr-status": prStatus,
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
