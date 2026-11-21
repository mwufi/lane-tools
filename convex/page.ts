// The lane page and lanes index, served by the control plane itself.
// It holds no data: it reads the same JSON API the CLI uses, with the viewer's token.
export const PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lanes</title>
<style>
  :root { --bg:#fbfaf8; --card:#fff; --fg:#1d1b18; --muted:#6f6a62; --line:#e7e3dc; --accent:#3b6ef5;
          --ok:#1f8a4c; --warn:#b26b00; --bad:#c2372d; --chip:#f1eee9; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151412; --card:#1d1c19; --fg:#ece8e1; --muted:#9a948a;
          --line:#2f2d29; --accent:#7c9cff; --ok:#4cc27e; --warn:#e3a33b; --bad:#ef6a5f; --chip:#27251f; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1040px; margin: 0 auto; padding: 28px 16px 60px; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 28px 0 10px; }
  a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  .sub { color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
  .kv b { display:block; font-size:12px; color:var(--muted); font-weight:500; margin-bottom:2px; }
  .kv span, .kv a { word-break: break-all; }
  table { width:100%; border-collapse: collapse; }
  th, td { text-align:left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size:12px; color: var(--muted); font-weight: 500; }
  tr:last-child td { border-bottom: 0; }
  .tablewrap { overflow-x: auto; }
  .pill { display:inline-flex; align-items:center; gap:6px; padding:2px 9px; border-radius: 999px; background: var(--chip); font-size:12px; white-space:nowrap; }
  .dot { width:7px; height:7px; border-radius:50%; background: var(--muted); }
  .s-ready .dot, .s-working .dot, .s-deploy_ok .dot { background: var(--ok); }
  .s-provisioning .dot, .s-waiting .dot, .s-deploying .dot { background: var(--warn); }
  .s-failed .dot, .s-deploy_failed .dot { background: var(--bad); }
  .vendor { font-weight: 600; text-transform: capitalize; }
  .story { list-style:none; margin:0; padding:0; }
  .story li { display:grid; grid-template-columns: 70px 26px 1fr; gap: 8px; padding: 10px 2px; border-bottom: 1px solid var(--line); align-items:start; }
  .story li:last-child { border-bottom:0; }
  .story .when { color: var(--muted); font-size: 12px; padding-top: 2px; white-space: nowrap; }
  .story .icon { font-size: 16px; line-height: 1.2; }
  .story .sub { font-size: 13px; margin-top: 2px; }
  .story .t-bad > div > div:first-child { color: var(--bad); }
  .story .t-muted { opacity: .75; }
  .story details summary { cursor: pointer; list-style: none; }
  .story details summary::-webkit-details-marker { display: none; }
  .story details summary > div:first-child::after { content: " ▸"; color: var(--muted); font-size: 11px; }
  .story details[open] summary > div:first-child::after { content: " ▾"; }
  .steps { list-style: none; margin: 8px 0 2px; padding: 8px 10px; border-left: 2px solid var(--line); font-size: 13px; }
  .steps li { display: flex; gap: 10px; padding: 3px 0; border: 0; }
  .steps .when { min-width: 80px; }
  .log { white-space: pre-wrap; font-size: 12px; margin: 0; color: var(--bad); }
  .row { display:flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .err { color: var(--bad); white-space: pre-wrap; }
  input { font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); width: 100%; max-width: 420px; }
  button { font: inherit; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--accent); color: #fff; cursor: pointer; }
</style>
</head>
<body><main id="app"><p class="sub">Loading…</p></main>
<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const short = (sha) => sha ? sha.slice(0, 7) : "–";
function ago(t) { const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return Math.floor(s) + "s ago"; if (s < 3600) return Math.floor(s/60) + "m ago";
  if (s < 86400) return Math.floor(s/3600) + "h ago"; return Math.floor(s/86400) + "d ago"; }
function pill(state, label) { return '<span class="pill s-' + esc(state) + '"><span class="dot"></span>' + esc(label ?? state) + '</span>'; }

function token() {
  const m = location.hash.match(/token=([^&]+)/);
  if (m) { try { localStorage.setItem("laneToken", m[1]); } catch {} history.replaceState(null, "", location.pathname + location.search); return m[1]; }
  try { return localStorage.getItem("laneToken"); } catch { return null; }
}
let TOKEN = token();
const params = new URLSearchParams(location.search);
const repo = params.get("repo"), branch = params.get("branch");

async function api(path) {
  const r = await fetch(path, { headers: { authorization: "Bearer " + TOKEN } });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j;
}

function askToken(msg) {
  $("#app").innerHTML = '<h1>Lanes</h1><p class="sub">' + esc(msg || "Paste your lane token to view lanes. It stays in this browser.") +
    '</p><div class="row"><input id="tok" type="password" placeholder="lane_…"><button id="go">View</button></div>';
  $("#go").onclick = () => { TOKEN = $("#tok").value.trim(); try { localStorage.setItem("laneToken", TOKEN); } catch {} tick(); };
}

function laneLink(l) { return "/lane?repo=" + encodeURIComponent(l.repo) + "&branch=" + encodeURIComponent(l.branch); }

function renderIndex(lanes) {
  const open = lanes.filter((l) => l.state !== "deleted");
  let h = '<h1>Lanes</h1><p class="sub">' + open.length + ' open · one shared backend per branch, for every agent on it</p>';
  h += '<div class="card tablewrap" style="margin-top:18px"><table><tr><th>Branch</th><th>Repo</th><th>State</th><th>Agents</th><th>Deployed</th><th>Activity</th></tr>';
  for (const l of lanes) {
    h += '<tr><td><a href="' + laneLink(l) + '"><b>' + esc(l.branch) + '</b></a></td><td class="sub">' + esc(l.repo) + '</td><td>' + pill(l.state) +
      '</td><td>' + l.activeAgents + ' active <span class="sub">/ ' + l.totalAgents + '</span></td><td class="mono">' + short(l.deployedSha) +
      '</td><td class="sub">' + ago(l.lastActivity) + '</td></tr>';
  }
  if (!lanes.length) h += '<tr><td colspan="6" class="sub">No lanes yet. Run <code>lane up</code> on a branch.</td></tr>';
  $("#app").innerHTML = h + '</table></div>';
}

// ---- turn raw events into a readable story: one row per push, with its deploy folded in
function who(actor) {
  const a = String(actor || "");
  if (a === "control-plane") return "Lanes";
  if (/^(lane-deployer|github-actions)/.test(a)) return "The deployer";
  let m = a.match(/^([a-z]+)@/); if (m) return cap(m[1]) + "'s deploy";
  m = a.match(/^([a-z]+)\\/(.+)$/); if (m) return m[1] === "github" ? esc(m[2]) + " (GitHub)" : cap(m[1]) + ' <span class="sub">for ' + esc(m[2]) + '</span>';
  return esc(a);
}
function cap(s) { return esc(s.charAt(0).toUpperCase() + s.slice(1)); }
function dur(str) { const n = parseFloat(str); if (!(n >= 0)) return str; return n < 60 ? Math.round(n) + "s" : Math.floor(n / 60) + "m " + Math.round(n % 60) + "s"; }
function shaOf(d) { const m = String(d).match(/^([0-9a-f]{7,40})/); return m ? m[1].slice(0, 7) : null; }
function code(s) { return '<code>' + esc(s) + '</code>'; }
const OPEN = new Set(); // which activity rows are expanded, kept across the 2s refresh
function timeline(events) {
  const evs = events.slice().reverse(); // oldest first
  const rows = [], bySha = {};
  for (const e of evs) {
    const sha = shaOf(e.detail);
    const d = String(e.detail);
    switch (e.type) {
      case "provisioning": rows.push({ at: e.at, icon: "🛣️", tone: "info", text: who(e.actor) + " opened this lane", sub: d === "re-provisioning" ? "Fresh backend for a branch that had a lane before" : "" }); break;
      case "ready": { const m = d.match(/deployment (\\S+) ready in ([\\d.]+)s/); rows.push({ at: e.at, icon: "✅", tone: "ok", text: "Backend created" + (m ? " in " + dur(m[2]) : ""), sub: m ? code(m[1]) : "" }); break; }
      case "revived": rows.push({ at: e.at, icon: "♻️", tone: "ok", text: "Lane reopened before its backend was deleted", sub: "" }); break;
      case "failed": rows.push({ at: e.at, icon: "⛔", tone: "bad", text: "Couldn't create the backend", sub: esc(d) }); break;
      case "join": rows.push({ at: e.at, icon: "👋", tone: "info", text: who(e.actor) + " joined", sub: "“" + esc(d) + "”" }); break;
      case "leave": rows.push({ at: e.at, icon: "🏁", tone: "muted", text: who(e.actor) + " finished", sub: "“" + esc(d) + "”" }); break;
      case "push": {
        const backend = d.includes("convex/ changed") || !d.includes("unchanged");
        const r = backend
          ? { key: "d" + sha, at: e.at, icon: "⏳", tone: "warn", sha, status: "Queued",
              text: "Convex deploy of " + code(sha || "?"), sub: who(e.actor) + " pushed a backend change", steps: [] }
          : { key: "p" + sha, at: e.at, icon: "⬆️", tone: "ok", sha, text: who(e.actor) + " pushed " + code(sha || "?"),
              sub: "Frontend-only change, so there was nothing to deploy", steps: [] };
        r.steps.push({ at: e.at, text: who(e.actor) + " pushed " + code(sha || "?") + (backend ? " (convex/ changed)" : " (convex/ unchanged)") });
        rows.push(r); if (sha && backend) bySha[sha] = r; break;
      }
      case "deploy_start": {
        let r = sha && bySha[sha];
        if (!r) { r = { key: "d" + sha, at: e.at, sha, text: "Convex deploy of " + code(sha || "?"), sub: "First deploy of the branch", steps: [] }; rows.push(r); if (sha) bySha[sha] = r; }
        r.icon = "⏳"; r.tone = "warn"; r.status = "In progress"; r.start = e.at;
        r.steps.push({ at: e.at, text: who(e.actor) + " took the deploy lock and started deploying" });
        break;
      }
      case "deploy_ok": {
        const total = d.match(/total ([\\d.]+)s/), dep = d.match(/deploy ([\\d.]+)s/), setup = d.match(/(?:seed|setup)[^,]*? ([\\d.]+)s/);
        const parts = [dep && "deploy " + dur(dep[1]), setup && "first-time setup and seed " + dur(setup[1])].filter(Boolean).join(", ");
        const r = (sha && bySha[sha]) || (rows.push({ key: "d" + sha, at: e.at, sha, text: "Convex deploy of " + code(sha || "?"), sub: "", steps: [] }), rows[rows.length - 1]);
        r.icon = "🚀"; r.tone = "ok"; r.at = e.at; r.status = "Done"; r.took = total ? dur(total[1]) : "";
        r.steps.push({ at: e.at, text: "Live" + (parts ? ": " + parts : "") });
        break;
      }
      case "deploy_failed": {
        const r = (sha && bySha[sha]) || (rows.push({ key: "d" + sha, at: e.at, sha, text: "Convex deploy of " + code(sha || "?"), sub: "", steps: [] }), rows[rows.length - 1]);
        r.icon = "❌"; r.tone = "bad"; r.at = e.at; r.status = "Failed";
        r.sub = "The lane keeps running the previous version";
        r.steps.push({ at: e.at, text: '<pre class="log">' + esc(d.replace(/^\\S+\\s*/, "").slice(0, 1500)) + '</pre>' });
        break;
      }
      case "key_minted":
        if (d.startsWith("deployer") && sha === null) { const r = Object.values(bySha).reverse().find((x) => x.status === "In progress"); if (r) r.steps.push({ at: e.at, text: "Minted a 31-minute deploy key for this deploy" }); }
        if (d.startsWith("agent")) rows.push({ at: e.at, icon: "🔑", tone: "muted", text: who(e.actor) + " got a 4-hour access key", sub: "Scoped to this lane's backend only" });
        break; // deployer keys are plumbing; folded into the deploy row
      case "archived": { const m = d.match(/^(.*?); deployment deleted in (\\d+)s/); rows.push({ at: e.at, icon: "📦", tone: "muted",
        text: "Lane shut down by " + who(e.actor) + (m ? " (" + esc(m[1]) + ")" : ""), sub: "Keys revoked now; backend " + (m ? "deleted in " + dur(m[2]) : "deleted soon") + " unless the lane is reopened" }); break; }
      case "deleted": rows.push({ at: e.at, icon: "🗑️", tone: "muted", text: "Backend deleted", sub: "" }); break;
      default: rows.push({ at: e.at, icon: "•", tone: "muted", text: esc(e.type) + " · " + who(e.actor), sub: esc(d) });
    }
  }
  return rows.reverse();
}

function renderLane(v) {
  const l = v.lane;
  const live = l.deployedSha && l.deployedSha === l.headSha;
  const deployState = (l.state === "deleted" || l.state === "archived") ? "" : l.deploying ? pill("deploying", "deploying " + short(l.deploying.sha)) : live ? pill("ready", "live = HEAD") : l.headSha ? pill("waiting", "behind HEAD") : pill("waiting", "nothing pushed");
  let h = '<p class="sub"><a href="/">All lanes</a> · ' + esc(l.repo) + '</p>';
  h += '<div class="row"><h1>' + esc(l.branch) + '</h1>' + pill(l.state) + deployState + '</div>';
  h += '<p class="sub">Created by ' + esc(l.createdBy) + ' ' + ago(l.createdAt) + (l.readyAt ? ' · ready in ' + ((l.readyAt - l.createdAt)/1000).toFixed(1) + 's' : '') + '</p>';
  if (l.error) h += '<p class="err">' + esc(l.error) + '</p>';
  h += '<h2>Resources</h2><div class="grid">';
  h += '<div class="card kv"><b>Convex</b>' + (l.deploymentUrl ? '<a href="' + esc(l.dashboardUrl) + '" target="_blank">' + esc(l.deploymentName) + '</a>' : '<span class="sub">not provisioned</span>') + '</div>';
  h += '<div class="card kv"><b>Client URL</b><span class="mono">' + esc(l.deploymentUrl || "–") + '</span></div>';
  h += '<div class="card kv"><b>HTTP actions</b><span class="mono">' + esc(l.siteUrl || "–") + '</span></div>';
  h += '<div class="card kv"><b>Branch HEAD → deployed</b><span class="mono">' + short(l.headSha) + ' → ' + short(l.deployedSha) + '</span>' + (l.seeded ? ' <span class="sub">· seeded</span>' : '') + '</div>';
  h += '</div>';
  const agents = v.agents.slice().sort((a, b) => (a.status === "done") - (b.status === "done") || b.lastSeen - a.lastSeen);
  h += '<h2>Agents on this branch (' + agents.filter(a => a.status !== "done").length + ' active)</h2><div class="card tablewrap"><table><tr><th>Agent</th><th>Person</th><th>Task</th><th>Status</th><th>Machine</th><th>Last seen</th><th>Last push</th><th>Thread</th></tr>';
  for (const a of agents) {
    h += '<tr><td class="vendor">' + esc(a.vendor) + '</td><td>' + esc(a.person) + '</td><td>' + esc(a.task) + '</td><td>' + pill(a.status) + '</td><td class="sub">' + esc(a.machine) +
      '</td><td class="sub">' + ago(a.lastSeen) + '</td><td class="mono">' + short(a.lastSha) + '</td><td>' + (a.threadUrl ? '<a href="' + esc(a.threadUrl) + '" target="_blank">open</a>' : '<span class="sub">–</span>') + '</td></tr>';
  }
  if (!agents.length) h += '<tr><td colspan="8" class="sub">No agents yet. Each agent runs <code>lane join --task "…"</code>.</td></tr>';
  h += '</table></div>';
  const story = timeline(v.events);
  h += '<h2>What happened</h2><div class="card"><ol class="story">';
  for (const r of story) {
    const head = '<div>' + r.text + (r.status ? ' ' + pill(r.status === "Done" ? "ready" : r.status === "Failed" ? "failed" : "waiting", r.status + (r.took ? " · " + r.took : "")) : "") + '</div>' +
      (r.sub ? '<div class="sub">' + r.sub + '</div>' : '');
    let body = head;
    if (r.steps && r.steps.length > 1) {
      body = '<details data-key="' + esc(r.key) + '"' + (OPEN.has(r.key) ? ' open' : '') + '><summary>' + head + '</summary><ol class="steps">' +
        r.steps.map((st) => '<li><span class="when">' + new Date(st.at).toLocaleTimeString() + '</span><span>' + st.text + '</span></li>').join("") + '</ol></details>';
    }
    h += '<li class="t-' + r.tone + '"><span class="when">' + ago(r.at) + '</span><span class="icon">' + r.icon + '</span><div>' + body + '</div></li>';
  }
  if (!story.length) h += '<li class="sub">Nothing yet.</li>';
  h += '</ol></div>';
  $("#app").innerHTML = h;
  for (const d of document.querySelectorAll("details[data-key]")) d.ontoggle = () => { d.open ? OPEN.add(d.dataset.key) : OPEN.delete(d.dataset.key); };
  document.title = l.branch + " · lane";
}

async function tick() {
  if (!TOKEN) return askToken();
  try {
    if (repo && branch) renderLane(await api("/api/lane?repo=" + encodeURIComponent(repo) + "&branch=" + encodeURIComponent(branch)));
    else renderIndex(await api("/api/lanes"));
  } catch (e) {
    if (String(e.message).includes("token")) return askToken(e.message);
    $("#app").innerHTML = '<p class="err">' + esc(e.message) + '</p>';
  }
}
tick(); setInterval(tick, 2000);
</script>
</body></html>`;
