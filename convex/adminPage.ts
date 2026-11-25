// The admin panel at /admin. Like the lane page it holds no data: it calls /api/admin/*
// with the viewer's lane token, and those routes check the viewer is in LANE_ADMIN_GITHUB_USERS.
export const ADMIN_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lane admin</title>
<style>
  :root { --bg:#fcfcfd; --card:#fff; --fg:#1b1c1f; --muted:#6b6f76; --faint:#9a9ea6; --line:#ebecee; --hover:#f6f6f8; --accent:#5e6ad2;
          --ok:#4cb782; --warn:#e2a336; --bad:#eb5757; --chip:#f2f2f4; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1012; --card:#16171a; --fg:#e6e6e8; --muted:#8a8f98; --faint:#62666d; --line:#25272b; --hover:#1c1d21;
          --accent:#7c86e8; --ok:#4cb782; --warn:#f0b54a; --bad:#f07070; --chip:#212226; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:13.5px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  main { max-width: 980px; margin: 0 auto; padding: 28px 16px 60px; }
  h1 { font-size: 20px; margin: 0; letter-spacing: -0.015em; font-weight: 600; }
  h2 { font-size: 12px; color: var(--muted); font-weight: 500; margin: 28px 0 8px; }
  a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  code { background: var(--chip); padding: 1px 5px; border-radius: 4px; }
  .sub { color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
  .pad { padding: 12px 14px; }
  .tablewrap { overflow-x: auto; }
  table { width:100%; border-collapse: collapse; }
  th, td { text-align:left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { font-size:12px; color: var(--muted); font-weight: 500; }
  tr:last-child td { border-bottom: 0; }
  tr.off td { color: var(--faint); }
  .pill { display:inline-flex; align-items:center; gap:6px; padding:1px 8px; border-radius: 999px; border: 1px solid var(--line); font-size:12px; white-space:nowrap; color: var(--muted); }
  .dot { width:7px; height:7px; border-radius:50%; background: var(--faint); }
  .s-ready .dot, .s-on .dot { background: var(--ok); }
  .s-provisioning .dot { background: var(--warn); }
  .s-failed .dot, .s-off .dot { background: var(--bad); }
  .row { display:flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .grow { flex: 1; }
  .tabs { display:flex; gap: 2px; margin: 18px 0 4px; border-bottom: 1px solid var(--line); }
  .tabs button { background: none; color: var(--muted); border: 0; border-bottom: 2px solid transparent; border-radius: 0; padding: 8px 12px; }
  .tabs button.on { color: var(--fg); border-bottom-color: var(--accent); }
  input, select, textarea { font: inherit; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); min-width: 0; }
  textarea { width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  button { font: inherit; padding: 7px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--accent); color: #fff; cursor: pointer; }
  button.ghost { background: var(--card); color: var(--fg); }
  button.danger { background: var(--card); color: var(--bad); }
  button.small { padding: 3px 9px; font-size: 12px; }
  .note { padding: 10px 14px; border-radius: 8px; background: var(--chip); margin: 10px 0; }
  .note.ok { border-left: 3px solid var(--ok); } .note.err { border-left: 3px solid var(--bad); color: var(--bad); }
  .secret { display:flex; gap: 8px; align-items: center; margin-top: 6px; }
  .secret input { flex: 1; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .kvs { display:grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 12.5px; }
  .kvs b { color: var(--muted); font-weight: 500; }
  .repo { margin-bottom: 14px; }
  .repo > .head { display:flex; align-items:center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
  .repo > .head b { font-size: 13.5px; }
  .field { display:grid; grid-template-columns: 150px 1fr; gap: 10px; padding: 8px 14px; align-items: start; border-bottom: 1px solid var(--line); }
  .field:last-child { border-bottom: 0; }
  .field > label { color: var(--muted); font-size: 12.5px; padding-top: 7px; }
  .chips { display:flex; flex-wrap: wrap; gap: 6px; }
  .empty { padding: 14px; color: var(--muted); }
  .progress { display:flex; align-items:center; gap: 12px; margin: 18px 0 6px; }
  .progress .track { flex: 1; height: 6px; border-radius: 3px; background: var(--chip); overflow: hidden; }
  .progress .track i { display:block; height: 100%; background: var(--ok); border-radius: 3px; }
  .progress b { font-weight: 500; font-variant-numeric: tabular-nums; }
  .group { margin-top: 22px; }
  .group > h3 { font-size: 12px; color: var(--muted); font-weight: 500; margin: 0 0 8px; }
  .step { border-bottom: 1px solid var(--line); }
  .step:last-child { border-bottom: 0; }
  .step > summary { display:grid; grid-template-columns: 22px 1fr auto; gap: 10px; align-items: center; padding: 11px 14px; cursor: pointer; list-style: none; }
  .step > summary::-webkit-details-marker { display:none; }
  .step > summary:hover { background: var(--hover); }
  .check { width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid var(--faint); display:inline-flex; align-items:center; justify-content:center; }
  .done .check { background: var(--ok); border-color: var(--ok); }
  .done .check::after { content: ""; width: 5px; height: 9px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg) translate(-1px, -1px); }
  .warn .check { border-color: var(--bad); }
  .next .check { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
  .step .t { font-weight: 500; }
  .step.done .t { color: var(--muted); }
  .step .d { color: var(--muted); font-size: 12.5px; }
  .step .tag { font-size: 11.5px; color: var(--faint); }
  .how { padding: 0 14px 14px 46px; font-size: 13px; }
  .how ol { margin: 0; padding-left: 18px; } .how li { margin: 6px 0; }
  .how .bad { color: var(--bad); }
  pre.snip { position: relative; margin: 6px 0; padding: 10px 12px; background: var(--chip); border-radius: 8px; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; }
  pre.snip button { position: absolute; top: 6px; right: 6px; }
  @media (max-width: 640px) { .field { grid-template-columns: 1fr; gap: 4px; } .field > label { padding-top: 0; } .hide-sm { display:none; } }
</style>
</head>
<body><main id="app"><p class="sub">Loading…</p></main>
<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
function ago(t) { if (!t) return "–"; const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return Math.floor(s) + "s ago"; if (s < 3600) return Math.floor(s/60) + "m ago";
  if (s < 86400) return Math.floor(s/3600) + "h ago"; return Math.floor(s/86400) + "d ago"; }
function pill(state, label) { return '<span class="pill s-' + esc(state) + '"><span class="dot"></span>' + esc(label ?? state) + '</span>'; }
const DAY = 86400000;

function token() {
  const m = location.hash.match(/token=([^&]+)/);
  if (m) { try { localStorage.setItem("laneToken", m[1]); } catch {} history.replaceState(null, "", location.pathname + location.search); return m[1]; }
  try { return localStorage.getItem("laneToken"); } catch { return null; }
}
let TOKEN = token();
let TAB = (location.hash.match(/tab=(\\w+)/) || [])[1] || "start";
let DATA = null, FLASH = null, NEWTOKEN = null, PREFILL = null;

async function api(path, body) {
  const r = await fetch(path, body === undefined ? { headers: { authorization: "Bearer " + TOKEN } } :
    { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(j.error || "HTTP " + r.status); e.status = r.status; throw e; } return j;
}

async function signIn(msg) {
  let cfg = {}, st = {}; try { cfg = await (await fetch("/api/auth/config")).json(); st = await (await fetch("/api/admin/status")).json(); } catch {}
  if (st.adminsConfigured === false) return firstRun(st);
  $("#app").innerHTML = '<h1>Lane admin</h1><p class="sub">' + esc(msg || "Sign in as a lane admin.") + '</p>' +
    (cfg.webLogin ? '<p><a href="/auth/github/start?next=admin"><button>Sign in with GitHub</button></a></p><p class="sub">or paste a lane token minted for your GitHub login:</p>' : '<p class="sub">Paste a lane token minted for your GitHub login:</p>') +
    '<div class="row"><input id="tok" type="password" placeholder="lane_…" style="width:320px"><button id="go">Continue</button></div>';
  $("#go").onclick = () => { TOKEN = $("#tok").value.trim(); try { localStorage.setItem("laneToken", TOKEN); } catch {} load(); };
}

function firstRun(st) {
  $("#app").innerHTML = '<h1>Set up lanes</h1><p class="sub">One shared cloud backend per branch, for every person and agent on it. Three minutes to the admin panel:</p>' +
    '<div class="card pad how" style="padding-left:14px"><ol>' +
    '<li>Open the Convex dashboard for this deployment (lane-control): <b>Settings, Environment variables</b>.</li>' +
    '<li>Add <code>LANE_ADMIN_GITHUB_USERS</code> with your GitHub username (comma-separate several).</li>' +
    '<li>Get a token for yourself, either way:' + snip("npx convex run admin:createToken " + "'" + JSON.stringify({ person: "<your GitHub username>" }) + "'") +
    (st.githubSignIn ? 'or sign in with GitHub below.' : 'GitHub sign-in is not set up yet; the panel walks you through it next.') + '</li>' +
    '<li>Reload this page and continue.</li></ol></div>' +
    '<p><button class="ghost" onclick="location.reload()">Reload</button>' + (st.githubSignIn ? ' <a href="/auth/github/start?next=admin"><button>Sign in with GitHub</button></a>' : '') + '</p>' +
    '<p class="sub">Already have a token? <a href="#" id="paste">Paste it</a>.</p>';
  wireSnips();
  $("#paste").onclick = (e) => { e.preventDefault(); const t = prompt("Lane token"); if (t) { TOKEN = t.trim(); try { localStorage.setItem("laneToken", TOKEN); } catch {} load(); } };
}

function snip(text) { return '<pre class="snip"><button class="small ghost" data-copy>Copy</button>' + esc(text) + '</pre>'; }
function wireSnips() {
  document.querySelectorAll("[data-copy]").forEach((b) => b.onclick = (e) => {
    e.preventDefault(); const pre = b.parentElement; const text = pre.textContent.replace(/^Copy/, "");
    navigator.clipboard?.writeText(text); b.textContent = "Copied"; setTimeout(() => b.textContent = "Copy", 1200); });
}

async function act(fn, ok) {
  try { const r = await fn(); FLASH = ok ? { ok: true, msg: typeof ok === "function" ? ok(r) : ok } : null; await load(); }
  catch (e) { FLASH = { ok: false, msg: e.message }; render(); }
}

async function load() {
  if (!TOKEN) return signIn();
  try { DATA = await api("/api/admin/overview"); render(); }
  catch (e) { if (e.status === 401 || e.status === 403) return signIn(e.message); $("#app").innerHTML = '<p class="note err">' + esc(e.message) + '</p>'; }
}

function setTab(t) { TAB = t; history.replaceState(null, "", "#tab=" + t); render(); }

function render() {
  const d = DATA; if (!d) return;
  const open = d.lanes.filter((l) => l.state !== "deleted" && l.state !== "archived");
  const live = d.tokens.filter((t) => !t.revoked);
  let h = '<div class="row"><h1 class="grow">Lane admin</h1><span class="sub">' + esc(d.person) + '</span><a href="/">Lanes</a></div>';
  h += '<div class="tabs">' + [["start", "Get started" + (stepsLeft(d) ? " · " + stepsLeft(d) : "")], ["lanes", "Lanes · " + open.length], ["tokens", "Tokens · " + live.length], ["repos", "Repos · " + d.repos.length], ["access", "Access"]]
    .map(([k, l]) => '<button data-tab="' + k + '" class="' + (TAB === k ? "on" : "") + '">' + esc(l) + '</button>').join("") + '</div>';
  if (FLASH) h += '<div class="note ' + (FLASH.ok ? "ok" : "err") + '">' + esc(FLASH.msg) + '</div>';
  h += ({ start: startTab, lanes: lanesTab, tokens: tokensTab, repos: reposTab, access: accessTab })[TAB](d);
  $("#app").innerHTML = h;
  document.querySelectorAll("[data-tab]").forEach((b) => b.onclick = (e) => { e.preventDefault(); FLASH = null; if (b.dataset.prefill) PREFILL = b.dataset.prefill; setTab(b.dataset.tab); });
  if (PREFILL && $("#tname")) { $("#tname").value = PREFILL; PREFILL = null; }
  wireSnips();
  wire();
}


// ---------------------------------------------------------------- Get started
// Every step checks itself from what the control plane has seen; nothing is ticked by hand.
function steps(d) {
  const o = d.onboarding, s = d.settings, site = s.siteUrl || location.origin;
  const repo = (o.repos[0] && o.repos[0].repo) || "owner/app";
  const go = (tab, label, prefill) => '<a href="#" data-tab="' + tab + '"' + (prefill ? ' data-prefill="' + esc(prefill) + '"' : '') + '><button class="small">' + esc(label) + '</button></a>';
  const dash = "the Convex dashboard for lane-control: <b>Settings, Environment variables</b>";
  return [
    { group: "Set up lane-control", items: [
      { title: "Lane-control is running", done: true, detail: site.replace(/^https?:\\/\\//, "") + " · you're signed in as " + d.person + ", an admin" },
      { title: "Connect Convex, where lanes are created",
        done: s.teamToken && (o.provisionedOnce || !o.failed), warn: s.teamToken && !o.provisionedOnce && !!o.failed,
        detail: !s.teamToken ? "No team token yet" : o.provisionedOnce ? "Verified: lanes have been created with it" : o.failed ? "A lane failed to start: " + o.failed.where : "Token set; it's verified when the first lane starts",
        how: '<ol><li>In the Convex dashboard, pick the team lanes should live in. Use one that does <b>not</b> own production.</li>' +
          '<li>Team settings, Access tokens: create a token.</li><li>In ' + dash + ', set <code>CONVEX_TEAM_TOKEN</code> to it.</li></ol>' +
          (o.failed && o.failed.error ? '<p class="bad">Last failure: ' + esc(o.failed.error) + '</p>' : '') },
      { title: "Let your team sign in with GitHub", optional: true,
        done: s.githubSignIn && (s.allowedUsers.length + s.allowedOrgs.length > 0),
        detail: !s.githubSignIn ? "Not set up; you can hand out tokens instead" : (s.allowedOrgs.length + s.allowedUsers.length) ? "Open to " + [...s.allowedOrgs.map((x) => x + " (org)"), ...s.allowedUsers].join(", ") : "Set up, but nobody is allowed yet",
        how: '<ol><li>GitHub, Settings, Developer settings, <b>New OAuth App</b>. Homepage URL and callback URL:' + snip(site) + snip(site + "/auth/github/callback") + 'Tick <b>Enable Device Flow</b> (for <code>lane login</code>).</li>' +
          '<li>In ' + dash + ', set <code>GITHUB_CLIENT_ID</code>, <code>GITHUB_CLIENT_SECRET</code>, and who may sign in: <code>LANE_ALLOWED_GITHUB_ORGS</code> (e.g. your org) and/or <code>LANE_ALLOWED_GITHUB_USERS</code>.</li></ol>' },
    ]},
    { group: "Add your repo", items: [
      { title: "Register a repo and its Convex project", done: o.repos.length > 0,
        detail: o.repos.length ? o.repos.map((r) => r.repo + " → project " + r.convexProjectId).join(", ") : "No repos yet",
        how: '<p>Each lane is a dev deployment in the repo\\'s Convex project. Find the project id in the Convex dashboard (Project settings).</p>' + go("repos", "Register a repo") },
      { title: "Seed every new lane", optional: true, done: o.repos.some((r) => r.setup > 0),
        detail: o.repos.some((r) => r.setup > 0) ? "Setup functions run once per lane" : "New lanes start empty",
        how: '<p>Add setup functions (migrations, then a seed such as <code>seed:run</code>) so every lane starts with sample data.</p>' + go("repos", "Edit repo settings") },
      { title: "Connect GitHub so pushes reach lanes", done: !!o.githubPush,
        detail: o.githubPush ? "Pushes recorded by " + o.githubPush.actor + (o.githubPush.where ? " on " + o.githubPush.where : "") : o.anyPush ? "Pushes so far came from people, not GitHub" : "No pushes from GitHub yet",
        how: '<ol><li>Mint a token for GitHub. ' + go("tokens", "Mint github-actions token", "github-actions") + '</li>' +
          '<li>In the repo on GitHub, Settings, Secrets and variables, Actions: add the secret <code>LANE_DEPLOYER_TOKEN</code> (that token) and the variable <code>LANE_URL</code>:' + snip(site) + '</li>' +
          '<li>Add a webhook (Settings, Webhooks) so pushes and PR merges reach lane-control. Content type <code>application/json</code>, events <b>Pushes</b> and <b>Pull requests</b>, and a random secret that you also set as <code>GITHUB_WEBHOOK_SECRET</code> in ' + dash + '. Payload URL:' + snip(site + "/github/webhook") + '</li>' +
          '<li>Commit these two files, then push any branch:' + snip(".lane.json\\n" + JSON.stringify({ repo, url: site }, null, 2)) + snip(DEPLOYER_YML) + '</li></ol>' },
    ]},
    { group: "Use it", items: [
      { title: "First lane live", done: !!o.firstLive, warn: !o.firstLive && !!o.failed,
        detail: o.firstLive ? o.firstLive.where + (o.firstLive.count > 1 ? " and " + (o.firstLive.count - 1) + " more" : "") : o.failed ? "Failed: " + o.failed.where : "No lane has deployed yet",
        how: '<p>Push a branch that changes <code>convex/</code>, or from any checkout of the repo:</p>' + snip("npm install -g github:mwufi/lane-tools\\nlane login --url " + site + "\\nlane join --task \\"try lanes\\"") +
          (o.failed && o.failed.error ? '<p class="bad">' + esc(o.failed.error) + '</p>' : '') + go("lanes", "See lanes") },
      { title: "First agent on a lane", done: !!o.agentJoined,
        detail: o.agentJoined ? "A " + o.agentJoined.vendor + " agent joined " + ago(o.agentJoined.at) : "No agent has joined a lane yet",
        how: '<ol><li>For each agent environment (Claude Code, Codex, Cursor, Amp): mint a token ' + go("tokens", "Mint agent token", "agents") + ' and store it as the secret <code>LANE_TOKEN</code>, with <code>LANE_URL</code> =' + snip(site) + '</li>' +
          '<li>In its setup script:' + snip("npm install -g github:mwufi/lane-tools") + '</li><li>The agent runs <code>lane join --task "…"</code> on its branch. The <code>skills/lane-setup</code> skill in lane-tools teaches any agent the workflow.</li></ol>' },
      { title: "First lane wound down after a merge", done: !!o.archived,
        detail: o.archived ? (o.archived.where || "A lane") + " archived " + ago(o.archived.at) : "Merge or close a PR whose branch has a lane",
        how: '<p>With GitHub connected, merging or closing the PR archives the lane: its keys are revoked at once and the deployment is deleted after the grace period.</p>' },
      { title: "Previews use their own lane", optional: true, done: !!o.envSet,
        detail: o.envSet ? "A lane set its own preview URL (" + (o.envSet.where || "") + ")" : "Vercel or Netlify previews built against the branch's lane",
        how: '<ol><li>Mint a token for your preview host ' + go("tokens", "Mint vercel token", "vercel") + ' and set it as <code>LANE_TOKEN</code> for Preview builds only.</li>' +
          '<li>In the preview build, wait for the commit to be live on the lane and build against its URL (see Cosign\\'s <code>deploy-vercel.sh</code>).</li>' +
          '<li>To give each lane its preview URL, add a per-lane env pattern such as <code>SITE_URL</code> in the repo settings, then run <code>lane env SITE_URL=https://…</code> from the build.</li></ol>' },
    ]},
  ];
}
const DEPLOYER_YML = ".github/workflows/lane-deployer.yml\\n" + [
  "name: lane deployer",
  "on:",
  "  push:",
  "    branches-ignore: [main]",
  "    paths: [\\"convex/**\\", \\"package-lock.json\\"]",
  "concurrency: { group: \\"lane-\${{ github.ref }}\\", cancel-in-progress: false }",
  "jobs:",
  "  deploy:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "        with: { fetch-depth: 0 }",
  "      - uses: actions/setup-node@v4",
  "        with: { node-version: 22 }",
  "      - run: npm ci",
  "      - run: npx -y github:mwufi/lane-tools deploy",
  "        env:",
  "          LANE_URL: \${{ vars.LANE_URL }}",
  "          LANE_TOKEN: \${{ secrets.LANE_DEPLOYER_TOKEN }}",
  "          LANE_DEPLOYER: github-actions",
].join("\\n");

function stepsLeft(d) { return steps(d).flatMap((g) => g.items).filter((x) => !x.done && !x.optional).length; }

function startTab(d) {
  const groups = steps(d), all = groups.flatMap((g) => g.items), req = all.filter((x) => !x.optional);
  const done = req.filter((x) => x.done).length, next = all.find((x) => !x.done && !x.optional) || all.find((x) => !x.done);
  let h = '<div class="progress"><div class="track"><i style="width:' + Math.round(100 * done / req.length) + '%"></i></div><b>' + done + ' of ' + req.length + '</b><span class="sub">' +
    (done === req.length ? "You're set up. Every branch can have a lane." : "Next: " + esc(next.title)) + '</span></div>' +
    '<p class="sub">Each step checks itself from what lane-control has seen. Reload after you finish one.</p>';
  for (const g of groups) {
    h += '<div class="group"><h3>' + esc(g.group) + '</h3><div class="card">';
    for (const x of g.items) {
      const cls = ["step", x.done ? "done" : "", x.warn ? "warn" : "", x === next ? "next" : ""].join(" ");
      h += '<details class="' + cls + '"' + (x === next ? " open" : "") + '><summary><span class="check"></span><span><div class="t">' + esc(x.title) +
        (x.optional ? ' <span class="tag">optional</span>' : '') + '</div><div class="d">' + esc(x.detail) + '</div></span><span class="sub">' + (x.how ? (x.done ? "details" : "how") : "") + '</span></summary>' +
        (x.how ? '<div class="how">' + x.how + '</div>' : '') + '</details>';
    }
    h += '</div></div>';
  }
  return h;
}

function lanesTab(d) {
  const rows = d.lanes.filter((l) => l.state !== "deleted");
  if (!rows.length) return '<div class="card empty">No lanes yet. A lane appears when a branch of a registered repo is pushed or someone runs <code>lane join</code>.</div>';
  return '<h2>Lanes</h2><div class="card tablewrap"><table><tr><th>Branch</th><th>State</th><th class="hide-sm">Repo</th><th>Agents</th><th class="hide-sm">Activity</th><th></th></tr>' +
    rows.map((l) => '<tr class="' + (l.state === "archived" ? "off" : "") + '"><td><a href="/lane?repo=' + encodeURIComponent(l.repo) + '&branch=' + encodeURIComponent(l.branch) + '">' + esc(l.branch) + '</a></td>' +
      '<td>' + pill(l.state) + '</td><td class="hide-sm">' + esc(l.repo) + '</td><td>' + esc(l.activeAgents) + '</td><td class="hide-sm">' + ago(l.lastActivity) + '</td>' +
      '<td>' + (l.state === "archived" ? "" : '<button class="small danger" data-archive="' + esc(l.repo) + '|' + esc(l.branch) + '">Archive</button>') + '</td></tr>').join("") +
    '</table></div><p class="sub">Archive revokes the lane\\'s keys now and deletes its deployment after the repo\\'s grace period. A push or reopened PR brings it back.</p>';
}

function tokensTab(d) {
  let h = '<h2>New token</h2><div class="card pad"><div class="row"><input id="tname" placeholder="name, e.g. github-actions, vercel, claude-cloud" style="flex:1;min-width:220px"><button id="mint">Mint token</button></div>';
  if (NEWTOKEN) h += '<div class="note ok"><b>' + esc(NEWTOKEN.person) + '</b>: copy it now, it won\\'t be shown again.<div class="secret"><input id="newtok" readonly value="' + esc(NEWTOKEN.token) + '"><button class="ghost" id="copy">Copy</button></div></div>';
  h += '<p class="sub" style="margin:8px 0 0">For a CI system or agent environment. People get their own token by signing in with GitHub (<code>lane login</code> or this page).</p></div>';
  h += '<h2>Tokens</h2><div class="card tablewrap"><table><tr><th>Name</th><th>Created</th><th class="hide-sm">By</th><th class="hide-sm">Last sign-in</th><th></th></tr>' +
    d.tokens.map((t) => '<tr class="' + (t.revoked ? "off" : "") + '"><td>' + esc(t.person) + '</td><td>' + ago(t.createdAt) + '</td><td class="hide-sm">' + esc(t.createdBy || "–") + '</td>' +
      '<td class="hide-sm">' + ago(t.lastSignIn) + '</td><td>' + (t.revoked ? '<span class="sub">revoked' + (t.revokedBy ? " by " + esc(t.revokedBy) : "") + '</span>' :
      '<button class="small danger" data-revoke="' + esc(t.id) + '" data-name="' + esc(t.person) + '">Revoke</button>') + '</td></tr>').join("") + '</table></div>';
  return h;
}

function reposTab(d) {
  let h = '<h2>Register a repo</h2><div class="card pad"><div class="row"><input id="nrepo" placeholder="owner/name" style="flex:1;min-width:180px"><input id="nproj" placeholder="Convex project id" inputmode="numeric" style="width:170px"><button id="addrepo">Register</button></div>' +
    '<p class="sub" style="margin:8px 0 0">Lanes are created as dev deployments in that Convex project. Then fill in setup functions and env below, and commit <code>.lane.json</code> to the repo.</p></div>';
  for (const r of d.repos) {
    const allow = Object.entries(r.laneEnvAllow).map(([k, v]) => k + " = " + v).join("\\n");
    h += '<h2>Settings</h2><div class="card repo" data-repo="' + esc(r.repo) + '">' +
      '<div class="head"><b class="grow">' + esc(r.repo) + '</b><span class="sub">' + r.openLanes + ' open lane' + (r.openLanes === 1 ? "" : "s") + '</span></div>' +
      field("Convex project", '<input data-k="convexProjectId" value="' + esc(r.convexProjectId) + '" inputmode="numeric" style="width:160px">') +
      field("Setup functions", '<input data-k="setupFunctions" value="' + esc(r.setupFunctions.join(", ")) + '" style="width:100%"><div class="sub">Run in order once per lane after its first deploy (migrations, then the seed). Comma-separated.</div>') +
      field("Deploy args", '<input data-k="deployArgs" value="' + esc(r.deployArgs.join(" ")) + '" style="width:100%"><div class="sub">Extra <code>convex deploy</code> args, space-separated.</div>') +
      field("Grace period", '<input data-k="graceDays" value="' + esc(+(r.graceMs / DAY).toFixed(3)) + '" inputmode="decimal" style="width:90px"> days <div class="sub">How long an archived lane\\'s deployment is kept before it is deleted.</div>') +
      field("Per-lane env", '<textarea data-k="laneEnvAllow" rows="' + Math.max(2, Object.keys(r.laneEnvAllow).length + 1) + '" placeholder="SITE_URL = https://app-git-[a-z0-9-]+-team\\\\.vercel\\\\.app">' + esc(allow) + '</textarea><div class="sub">Vars a lane may set for itself (<code>lane env</code>), one <code>NAME = pattern</code> per line. The value must match the pattern in full.</div>') +
      field("", '<button data-save="' + esc(r.repo) + '">Save settings</button>') +
      field("Lane env", '<div class="chips">' + (r.envNames.length ? r.envNames.map((n) => '<span class="pill">' + esc(n) + ' <a href="#" data-unset="' + esc(n) + '" title="Remove">×</a></span>').join("") : '<span class="sub">none</span>') + '</div>' +
        '<div class="row" style="margin-top:8px"><input data-envname placeholder="NAME" style="width:200px"><input data-envvalue type="password" placeholder="value" style="flex:1;min-width:160px"><button class="ghost" data-setenv="' + esc(r.repo) + '">Set</button></div>' +
        '<div class="sub">Set on every new lane of this repo. Values are write-only. Existing lanes keep the env they were created with.</div>') +
      '</div>';
  }
  return h;
}
function field(label, inner) { return '<div class="field"><label>' + esc(label) + '</label><div>' + inner + '</div></div>'; }

function accessTab(d) {
  const s = d.settings;
  const yes = (b, on, off) => pill(b ? "on" : "off", b ? on : off);
  const list = (xs) => xs.length ? xs.map((x) => '<code>' + esc(x) + '</code>').join(" ") : '<span class="sub">none</span>';
  return '<h2>Who can use lanes</h2><div class="card pad kvs">' +
    '<b>Admins</b><span>' + list(s.admins) + '</span>' +
    '<b>GitHub users</b><span>' + list(s.allowedUsers) + '</span>' +
    '<b>GitHub orgs</b><span>' + list(s.allowedOrgs) + '</span>' +
    '<b>GitHub sign-in</b><span>' + yes(s.githubSignIn, "configured", "not configured") + '</span>' +
    '<b>Convex team token</b><span>' + yes(s.teamToken, "set", "missing") + '</span>' +
    '<b>Webhook secret</b><span>' + yes(s.webhookSecret, "set", "not set (fine with the GitHub Action)") + '</span></div>' +
    '<p class="sub">These are lane-control deployment env vars (<code>LANE_ADMIN_GITHUB_USERS</code>, <code>LANE_ALLOWED_GITHUB_USERS</code>, <code>LANE_ALLOWED_GITHUB_ORGS</code>, <code>GITHUB_CLIENT_ID</code>/<code>SECRET</code>, <code>CONVEX_TEAM_TOKEN</code>). Change them in the Convex dashboard: lane-control, Production, Settings, Environment variables.</p>' +
    '<h2>Recent sign-ins</h2><div class="card tablewrap"><table><tr><th>Who</th><th>Via</th><th>When</th></tr>' +
    (d.signIns.length ? d.signIns.map((l) => '<tr><td>' + esc(l.person) + '</td><td>' + esc(l.via) + '</td><td>' + ago(l.at) + '</td></tr>').join("") : '<tr><td colspan="3" class="sub">No sign-ins yet</td></tr>') + '</table></div>';
}

function wire() {
  const on = (sel, fn) => document.querySelectorAll(sel).forEach((el) => el.onclick = (e) => { e.preventDefault(); fn(el); });
  on("[data-archive]", (b) => { const [repo, branch] = b.dataset.archive.split("|");
    if (confirm("Archive the lane for " + branch + "?")) act(() => api("/api/admin/lanes/archive", { repo, branch }), "Archived " + branch); });
  on("[data-revoke]", (b) => { if (confirm("Revoke the token " + b.dataset.name + "? Anything using it stops working.")) { NEWTOKEN = null; act(() => api("/api/admin/tokens/revoke", { id: b.dataset.revoke }), "Revoked " + b.dataset.name); } });
  on("#mint", () => act(async () => { NEWTOKEN = await api("/api/admin/tokens/create", { person: $("#tname").value.trim() }); return NEWTOKEN; }, (r) => "Minted " + r.person));
  on("#copy", () => { $("#newtok").select(); navigator.clipboard?.writeText($("#newtok").value); });
  on("#addrepo", () => act(() => api("/api/admin/repos/add", { repo: $("#nrepo").value.trim(), convexProjectId: Number($("#nproj").value) }), "Registered " + $("#nrepo").value.trim()));
  on("[data-save]", (b) => {
    const card = b.closest(".repo"), get = (k) => card.querySelector('[data-k="' + k + '"]').value.trim();
    const allow = {};
    for (const line of get("laneEnvAllow").split("\\n")) { const t = line.trim(); if (!t) continue;
      const i = t.indexOf("="); if (i < 1) { FLASH = { ok: false, msg: "Per-lane env lines look like NAME = pattern" }; return render(); }
      allow[t.slice(0, i).trim()] = t.slice(i + 1).trim(); }
    act(() => api("/api/admin/repos/update", {
      repo: card.dataset.repo,
      convexProjectId: Number(get("convexProjectId")),
      setupFunctions: get("setupFunctions").split(",").map((x) => x.trim()).filter(Boolean),
      deployArgs: get("deployArgs").split(/\\s+/).filter(Boolean),
      graceMs: Math.round(Number(get("graceDays")) * DAY),
      laneEnvAllow: allow,
    }), "Saved " + card.dataset.repo);
  });
  on("[data-setenv]", (b) => { const card = b.closest(".repo");
    const name = card.querySelector("[data-envname]").value.trim(), value = card.querySelector("[data-envvalue]").value;
    act(() => api("/api/admin/repos/env", { repo: card.dataset.repo, name, value }), "Set " + name + " on " + card.dataset.repo); });
  on("[data-unset]", (a) => { const card = a.closest(".repo");
    if (confirm("Remove " + a.dataset.unset + " from new lanes of " + card.dataset.repo + "?"))
      act(() => api("/api/admin/repos/env", { repo: card.dataset.repo, name: a.dataset.unset, value: null }), "Removed " + a.dataset.unset); });
}

load();
</script>
</body>
</html>`;
