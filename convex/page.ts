// The lane page and lanes index, served by the control plane itself.
// It holds no data: it reads the same JSON API the CLI uses, with the viewer's token.
export const PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lanes</title>
<style>
  :root { --bg:#fcfcfd; --card:#fff; --fg:#1b1c1f; --muted:#6b6f76; --faint:#9a9ea6; --line:#ebecee; --hover:#f6f6f8; --accent:#5e6ad2;
          --ok:#4cb782; --warn:#e2a336; --bad:#eb5757; --chip:#f2f2f4;
          --p-setup:#5e6ad2; --p-dev:#26a69a; --p-wind:#8a8f98; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1012; --card:#16171a; --fg:#e6e6e8; --muted:#8a8f98; --faint:#62666d; --line:#25272b; --hover:#1c1d21;
          --accent:#7c86e8; --ok:#4cb782; --warn:#f0b54a; --bad:#f07070; --chip:#212226;
          --p-setup:#7c86e8; --p-dev:#3fbfb2; --p-wind:#7d828b; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:13.5px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  main { max-width: 980px; margin: 0 auto; padding: 28px 16px 60px; }
  h1 { font-size: 20px; margin: 0; letter-spacing: -0.015em; font-weight: 600; }
  h2 { font-size: 12px; color: var(--muted); font-weight: 500; margin: 32px 0 8px; }
  a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  code { background: var(--chip); padding: 1px 5px; border-radius: 4px; }
  .sub { color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
  .pad { padding: 12px 14px; }
  table { width:100%; border-collapse: collapse; }
  th, td { text-align:left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { font-size:12px; color: var(--muted); font-weight: 500; }
  tr:last-child td { border-bottom: 0; }
  .tablewrap { overflow-x: auto; }
  .pill { display:inline-flex; align-items:center; gap:6px; padding:1px 8px; border-radius: 999px; border: 1px solid var(--line); font-size:12px; white-space:nowrap; color: var(--muted); }
  .dot { width:7px; height:7px; border-radius:50%; background: var(--faint); }
  .s-ready .dot, .s-working .dot { background: var(--ok); }
  .s-provisioning .dot, .s-waiting .dot, .s-deploying .dot, .s-idle .dot { background: var(--warn); }
  .s-failed .dot { background: var(--bad); }
  .s-open .dot { background: var(--ok); } .s-merged .dot { background: #8e6bd8; } .s-closed .dot { background: var(--bad); } .s-draft .dot { background: var(--faint); }
  .links { display:flex; flex-wrap:wrap; gap:8px; margin: 12px 0 0; }
  .link { display:inline-flex; align-items:center; gap:7px; padding:6px 11px; border:1px solid var(--line); border-radius:9px; background: var(--card); color: var(--fg); font-size:13px; text-decoration:none; max-width:100%; min-width:0; }
  .link:hover { background: var(--hover); }
  .link b { color: var(--muted); font-weight:500; }
  .link .t { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .link.none { color: var(--faint); border-style: dashed; }
  .minilinks a { margin-right: 10px; white-space: nowrap; }
  .row { display:flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .err { color: var(--bad); white-space: pre-wrap; }
  .grow { flex: 1; }
  button.ghost { background: transparent; color: var(--fg); padding: 5px 12px; font-size: 13px; }
  button.ghost:hover { border-color: var(--muted); }
  button:disabled { opacity: .5; cursor: default; }
  .banner { margin: 10px 0 0; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--line); font-size: 13.5px; }
  .banner.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 35%, transparent); background: color-mix(in srgb, var(--bad) 6%, transparent); }
  .banner summary { cursor: pointer; }
  input { font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); width: 100%; max-width: 420px; }
  button { font: inherit; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--accent); color: #fff; cursor: pointer; }
  .crumbs { font-size: 12.5px; margin-bottom: 8px; }
  .stats { display:flex; gap: 28px; flex-wrap: wrap; margin: 16px 0 4px; }
  .stat b { display:block; font-size: 11.5px; font-weight: 500; color: var(--muted); }
  .stat span { font-size: 15px; font-weight: 500; font-variant-numeric: tabular-nums; }
  /* timeline */
  .tlhead { display:flex; justify-content: space-between; align-items: baseline; margin: 28px 0 8px; }
  .tlhead h2 { margin: 0; }
  .legend { display:flex; gap: 12px; font-size: 11.5px; color: var(--muted); }
  .legend i { display:inline-block; width: 14px; height: 6px; border-radius: 2px; margin-right: 5px; vertical-align: middle; background: var(--faint); }
  .legend .lw { opacity: .3; } .legend .ls { background-image: repeating-linear-gradient(135deg, rgba(255,255,255,.55) 0 2px, transparent 2px 4px); }
  .phase { --pc: var(--faint); border-bottom: 1px solid var(--line); }
  .phase:last-child { border-bottom: 0; }
  .phase.setup { --pc: var(--p-setup); } .phase.dev { --pc: var(--p-dev); } .phase.wind { --pc: var(--p-wind); }
  .phase > summary { display:flex; align-items:center; gap: 10px; padding: 10px 14px; cursor: pointer; list-style: none; user-select: none; }
  .phase > summary::-webkit-details-marker, .it > summary::-webkit-details-marker { display:none; }
  .phase > summary:hover { background: var(--hover); }
  .ph-mark { width: 10px; height: 10px; border-radius: 3px; background: var(--pc); flex: none; }
  .ph-name { font-weight: 600; font-size: 13px; }
  .ph-sum { color: var(--muted); font-size: 12.5px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ph-dur { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); }
  .caret { width: 12px; color: var(--faint); font-size: 10px; transition: transform .12s; display:inline-block; }
  details[open] > summary .caret { transform: rotate(90deg); }
  .items { list-style: none; margin: 0 0 8px; padding: 0 0 0 19px; position: relative; }
  .items::before { content:""; position:absolute; left: 18px; top: 0; bottom: 8px; width: 2px; border-radius: 1px; background: var(--pc); opacity: .35; }
  .it > summary, .it > .line { display:grid; grid-template-columns: 22px 12px minmax(0,1fr) 150px 60px 58px; align-items:center; gap: 8px; padding: 6px 14px 6px 10px; list-style:none; border-radius: 6px; }
  .it > summary { cursor: pointer; }
  .it > summary:hover, .it > .line:hover { background: var(--hover); }
  .it .caret { justify-self: center; }
  .glyph { display:inline-flex; width: 14px; height: 14px; justify-self: center; }
  .glyph svg { width: 14px; height: 14px; }
  .ttl { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ttl .meta { color: var(--muted); margin-left: 6px; }
  .who { display:inline-flex; align-items:center; gap: 5px; color: var(--muted); margin-left: 6px; }
  .av { display:inline-flex; align-items:center; justify-content:center; width: 16px; height: 16px; border-radius: 50%; color:#fff; font-size: 9.5px; font-weight: 600; flex: none; text-transform: uppercase; }
  .bar { position: relative; height: 6px; border-radius: 3px; background: var(--chip); overflow: hidden; display:flex; }
  .bar i { display:block; height: 100%; background: var(--pc); min-width: 2px; }
  .bar i.w { opacity: .3; min-width: 0; }
  .bar i.s { background-image: repeating-linear-gradient(135deg, rgba(255,255,255,.55) 0 2px, transparent 2px 4px); }
  .bar.run i:last-child { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .45; } }
  .nobar { height: 6px; }
  .dur { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
  .ago { color: var(--faint); font-size: 12px; text-align: right; white-space: nowrap; }
  .st-failed .ttl { color: var(--bad); }
  .st-failed .bar i { background: var(--bad); }
  .st-skipped .ttl, .st-skipped .dur { color: var(--faint); }
  .steps { list-style:none; margin: 0 14px 6px 52px; padding: 2px 0 4px 12px; border-left: 1px solid var(--line); font-size: 12.5px; }
  .steps li { display:grid; grid-template-columns: 64px 1fr; gap: 8px; padding: 2px 0; color: var(--muted); }
  .steps li span:last-child { color: var(--fg); min-width: 0; }
  .steps .off { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: var(--faint); text-align: right; }
  .log { white-space: pre-wrap; max-height: 360px; overflow: auto; font-size: 11.5px; margin: 2px 0 0; color: var(--bad); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .empty { padding: 14px; color: var(--muted); }
  .kvs { display:grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 12.5px; }
  .kvs b { color: var(--muted); font-weight: 500; }
  .kvs span, .kvs a { word-break: break-all; }
  .agname { display:inline-flex; align-items:center; gap: 7px; font-weight: 500; }
  @media (max-width: 640px) {
    .it > summary, .it > .line { grid-template-columns: 22px 12px minmax(0,1fr) 54px; }
    .it .bar, .it .nobar, .it .ago { display:none; }
    .steps { margin-left: 30px; }
  }
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

async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) }
    : { headers: { authorization: "Bearer " + TOKEN } });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j;
}

async function askToken(msg) {
  let cfg = {}; try { cfg = await (await fetch("/api/auth/config")).json(); } catch {}
  $("#app").innerHTML = '<h1>Lanes</h1><p class="sub">' + esc(msg || "Sign in to see who's working on which branch.") + '</p>' +
    (cfg.webLogin ? '<p><a href="/auth/github/start"><button>Sign in with GitHub</button></a></p><p class="sub">or paste a lane token:</p>' : '') +
    '<div class="row"><input id="tok" type="password" placeholder="lane_…"><button id="go">View</button></div>';
  $("#go").onclick = () => { TOKEN = $("#tok").value.trim(); try { localStorage.setItem("laneToken", TOKEN); } catch {} tick(); };
}

function laneLink(l) { return "/lane?repo=" + encodeURIComponent(l.repo) + "&branch=" + encodeURIComponent(l.branch); }

function renderIndex(lanes) {
  const open = lanes.filter((l) => l.state !== "deleted");
  let h = '<h1>Lanes</h1><p class="sub">' + open.length + ' open · one shared backend per branch, for every agent on it</p>';
  h += '<div class="card tablewrap" style="margin-top:18px"><table><tr><th>Branch</th><th>Repo</th><th>State</th><th>Links</th><th>Agents</th><th>Deployed</th><th>Activity</th></tr>';
  for (const l of lanes) {
    h += '<tr><td><a href="' + laneLink(l) + '"><b>' + esc(l.branch) + '</b></a></td><td class="sub">' + esc(l.repo) + '</td><td>' + pill(l.state) +
      '</td><td>' + miniLinks(l) + '</td><td>' + l.activeAgents + ' active <span class="sub">/ ' + l.totalAgents + '</span></td><td class="mono">' + short(l.deployedSha) +
      '</td><td class="sub">' + ago(l.lastActivity) + '</td></tr>';
  }
  if (!lanes.length) h += '<tr><td colspan="7" class="sub">No lanes yet. Run <code>lane up</code> on a branch.</td></tr>';
  $("#app").innerHTML = h + '</table></div>';
}

// ---- the timeline: raw events grouped into phases, then activities, then steps
const PHASES = [
  { id: "setup", label: "Setup" },
  { id: "dev", label: "Development" },
  { id: "wind", label: "Wind down" },
];
const AV = ["#5e6ad2", "#26a69a", "#d9822b", "#c2459b", "#4a90d9", "#8e6bd8", "#3f9a5b", "#c25b4a"];
function avatar(name) {
  let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return '<span class="av" style="background:' + AV[h % AV.length] + '">' + esc(String(name).charAt(0)) + '</span>';
}
// Actors: agent names ("spicy-lobster", deploy holders add "#pid"), GitHub, the control plane, or older "vendor/person".
function actorName(actor) {
  const a = String(actor || "").replace(/#\\d+$/, "");
  if (a === "control-plane") return "lanes";
  if (/^(lane-deployer|github-actions)/.test(a)) return "deployer";
  const m = a.match(/^github\\/(.+)$/); if (m) return m[1];
  return a;
}
function who(actor) { const n = actorName(actor); return '<span class="who">' + avatar(n) + esc(n) + '</span>'; }
function dur(ms) {
  if (!(ms >= 0)) return "";
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1) + "s";
  if (s < 60) return Math.round(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + Math.round(s % 60) + "s";
  if (s < 86400) return Math.floor(s / 3600) + "h " + Math.round((s % 3600) / 60) + "m";
  return Math.floor(s / 86400) + "d " + Math.round((s % 86400) / 3600) + "h";
}
function secsIn(d, re) { const m = String(d).match(re); return m ? parseFloat(m[1]) * 1000 : null; }
function shaOf(d) { const m = String(d).match(/^([0-9a-f]{7,40})/); return m ? m[1].slice(0, 7) : null; }
function code(s) { return '<code>' + esc(s) + '</code>'; }
const SVG = {
  queued: '<svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--faint)" stroke-width="1.5" stroke-dasharray="2.2 2"/></svg>',
  running: '<svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--warn)" stroke-width="1.5"/><path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="var(--warn)"/></svg>',
  done: '<svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.5" fill="var(--ok)"/><path d="M4.3 7.2l1.8 1.8 3.6-3.8" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  failed: '<svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.5" fill="var(--bad)"/><path d="M5 5l4 4M9 5l-4 4" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>',
  skipped: '<svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--faint)" stroke-width="1.5"/><path d="M4.5 7h5" stroke="var(--faint)" stroke-width="1.5" stroke-linecap="round"/></svg>',
  push: '<svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--pc)" stroke-width="1.5"/><path d="M7 9.5v-5M4.9 6.4L7 4.3l2.1 2.1" fill="none" stroke="var(--pc)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function build(events) {
  const evs = events.slice().reverse(); // oldest first
  const items = [], bySha = {}, byAgent = {};
  let backend = null, teardown = null, deploys = 0;
  const add = (it) => { it.steps = it.steps || []; items.push(it); return it; };
  const deployFor = (sha, at) => {
    if (sha && bySha[sha]) return bySha[sha];
    const it = add({ key: "d" + sha, kind: "deploy", phase: deploys++ === 0 ? "setup" : "dev", sha, start: at, status: "queued", bar: true });
    if (sha) bySha[sha] = it;
    return it;
  };
  const running = () => items.slice().reverse().find((x) => x.kind === "deploy" && x.status === "running");
  for (const e of evs) {
    const d = String(e.detail), sha = shaOf(d), name = actorName(e.actor);
    switch (e.type) {
      case "provisioning":
        backend = add({ key: "b" + e.at, kind: "backend", phase: "setup", actor: e.actor, start: e.at, status: "running", bar: true,
          steps: [{ at: e.at, text: name + (d === "re-provisioning" ? " reopened the lane after an earlier one was deleted" : " opened the lane") }] });
        break;
      case "revived":
        // Restored in the grace period: the shutdown stops, and the lane carries on in development.
        if (teardown && teardown.status === "running") {
          teardown.status = "cancelled"; teardown.end = e.at;
          teardown.steps.push({ at: e.at, text: "Restored by " + name + "; the backend was kept" });
          teardown = null;
        }
        add({ key: "r" + e.at, kind: "revived", phase: "dev", actor: e.actor, start: e.at, end: e.at, status: "done" });
        break;
      case "ready": {
        const it = backend || add({ key: "b" + e.at, kind: "backend", phase: "setup", start: e.at, status: "running", bar: true });
        const m = d.match(/deployment (\\S+)/);
        it.status = "done"; it.end = e.at; it.dep = m ? m[1] : "";
        it.steps.push({ at: e.at, text: "Convex deployment " + code(it.dep || "?") + " is up" });
        break;
      }
      case "failed": {
        const it = backend || add({ key: "b" + e.at, kind: "backend", phase: "setup", start: e.at, bar: true });
        it.status = "failed"; it.end = e.at;
        it.steps.push({ at: e.at, text: '<pre class="log">' + esc(d.slice(0, 1500)) + '</pre>' });
        break;
      }
      case "join": {
        const it = add({ key: "a" + e.actor + e.at, kind: "agent", phase: "dev", actor: e.actor, task: d, start: e.at, status: "running",
          steps: [{ at: e.at, text: "Joined" }] });
        byAgent[e.actor] = it;
        break;
      }
      case "leave": {
        const it = byAgent[e.actor];
        if (it) { it.status = "done"; it.end = e.at; it.steps.push({ at: e.at, text: "Finished" }); }
        else add({ key: "l" + e.at, kind: "agent", phase: "dev", actor: e.actor, task: d, start: e.at, end: e.at, status: "done" });
        break;
      }
      case "push": {
        const backendChange = !d.includes("unchanged");
        const ag = byAgent[e.actor];
        if (ag) ag.steps.push({ at: e.at, text: "Pushed " + code(sha || "?") + (backendChange ? " (backend)" : " (frontend)") });
        if (backendChange) {
          const it = deployFor(sha, e.at);
          it.actor = it.actor || e.actor;
          it.steps.push({ at: e.at, text: name + " pushed " + code(sha || "?") + " with convex/ changes" });
        } else {
          add({ key: "p" + sha + e.at, kind: "push", phase: "dev", sha, actor: e.actor, start: e.at, end: e.at, status: "done" });
        }
        break;
      }
      case "deploy_start": {
        const it = deployFor(sha, e.at);
        it.actor = it.actor || e.actor; it.status = "running"; it.runAt = e.at;
        it.steps.push({ at: e.at, text: (actorName(e.actor) === actorName(it.actor) ? "Took the deploy lock" : name + " took the deploy lock") });
        break;
      }
      case "key_minted":
        if (d.startsWith("deployer")) { const it = running(); if (it) it.steps.push({ at: e.at, text: "Minted a 31-minute deploy key" }); }
        else if (byAgent[e.actor]) byAgent[e.actor].steps.push({ at: e.at, text: "Got a 4-hour key for this lane" });
        break;
      case "deploy_ok": {
        const it = deployFor(sha, e.at);
        const run = secsIn(d, /deploy ([\\d.]+)s/), seed = secsIn(d, /setup[^,]*? ([\\d.]+)s/);
        const runAt = it.runAt || it.start;
        it.status = "done"; it.end = e.at; it.seeded = seed != null;
        it.segs = { wait: runAt - it.start, run: run != null ? run : e.at - runAt - (seed || 0), seed: seed || 0 };
        if (run != null) it.steps.push({ at: runAt + run, text: "Functions deployed in " + dur(run) });
        if (seed != null) {
          const n = d.match(/setup \\((\\d+) fn\\)/);
          it.steps.push({ at: runAt + (run || 0) + seed, text: "Ran " + (n ? n[1] + " setup function" + (n[1] === "1" ? "" : "s") : "setup and seed") + " in " + dur(seed) });
        }
        it.steps.push({ at: e.at, text: "Live" });
        break;
      }
      case "deploy_failed": {
        const it = deployFor(sha, e.at);
        it.status = "failed"; it.end = e.at;
        it.steps.push({ at: e.at, text: "Failed; the lane keeps running the previous commit" + '<pre class="log">' + esc(d.replace(/^\\S+\\s*/, "").slice(0, 1500)) + '</pre>' });
        break;
      }
      case "archived": {
        for (const x of items) if (x.end == null && (x.kind === "agent" || x.status === "queued" || x.status === "running")) {
          x.end = e.at; x.status = x.kind === "agent" ? "done" : x.status === "running" ? "failed" : "skipped";
          if (x.kind === "agent") x.steps.push({ at: e.at, text: "Lane shut down" });
        }
        const m = d.match(/^(.*?); deployment deleted in (\\d+)s/);
        teardown = add({ key: "t" + e.at, kind: "teardown", phase: "wind", actor: e.actor, start: e.at, status: "running",
          reason: m ? m[1] : d, grace: m ? parseInt(m[2], 10) * 1000 : null,
          steps: [{ at: e.at, text: "Archived by " + name + (m ? " (" + esc(m[1]) + ")" : "") + "; all lane keys revoked" }] });
        break;
      }
      case "deleted": {
        const it = teardown || add({ key: "t" + e.at, kind: "teardown", phase: "wind", start: e.at, status: "running" });
        it.status = "done"; it.end = e.at;
        const took = secsIn(d, /in ([\\d.]+)s/);
        it.steps.push({ at: e.at, text: "Convex deployment deleted" + (took != null ? " in " + dur(took) : "") });
        break;
      }
      default:
        add({ key: "x" + e.at, kind: "other", phase: "dev", actor: e.actor, start: e.at, end: e.at, status: "done", type: e.type, detail: d });
    }
  }
  // A queued deploy that never started was folded into a later one.
  const ds = items.filter((x) => x.kind === "deploy");
  ds.forEach((x, i) => { if (x.status === "queued" && ds.slice(i + 1).some((y) => y.runAt)) { x.status = "skipped"; x.end = x.start; } });
  return items;
}

function titleOf(it) {
  switch (it.kind) {
    case "backend": return "Backend created" + (it.dep ? '<span class="meta">' + esc(it.dep) + '</span>' : "");
    case "revived": return "Lane restored" + who(it.actor) + '<span class="meta">kept the old backend</span>';
    case "deploy": {
      const what = it.status === "skipped" ? "Deploy skipped" : it.phase === "setup" ? "First deploy" : "Deploy";
      const meta = it.status === "skipped" ? "folded into the next deploy" : it.seeded ? "with seed" : it.status === "queued" ? "queued" : "";
      return what + " " + code(it.sha || "?") + who(it.actor) + (meta ? '<span class="meta">' + meta + '</span>' : "");
    }
    case "push": return "Frontend push " + code(it.sha || "?") + who(it.actor) + '<span class="meta">no deploy needed</span>';
    case "agent": return '<span class="agname">' + esc(actorName(it.actor)) + '</span><span class="meta">' + esc(it.task) + (it.status === "running" ? ' · <span style="color:var(--ok)">working</span>' : "") + '</span>';
    case "teardown": return (it.status === "done" ? "Lane shut down" : it.status === "cancelled" ? "Archived, then restored" : "Shutting down") + who(it.actor) +
      '<span class="meta">' + esc(it.reason || "") + (it.status === "running" && it.grace ? " · backend deleted " + dur(Math.max(0, it.start + it.grace - Date.now())) + " from now" : "") + '</span>';
    default: return esc(it.type) + who(it.actor) + '<span class="meta">' + esc(it.detail) + '</span>';
  }
}

function glyphOf(it) {
  if (it.kind === "push") return SVG.push;
  if (it.kind === "agent") return avatar(actorName(it.actor));
  return SVG[it.status] || SVG.done;
}

const OPEN = new Set();    // expanded activities, kept across the 2s refresh
const CLOSED = new Set();  // collapsed phases
function renderTimeline(items) {
  if (!items.length) return '<div class="card empty">Nothing yet.</div>';
  const now = Date.now();
  const len = (it) => Math.max(0, (it.end != null ? it.end : now) - it.start);
  const max = Math.max(1000, ...items.filter((i) => i.bar).map(len));
  const pct = (ms) => (100 * Math.max(0, ms) / max).toFixed(2) + "%";
  let h = '<div class="card">';
  for (const p of PHASES) {
    const its = items.filter((i) => i.phase === p.id);
    if (!its.length) continue;
    const t0 = Math.min(...its.map((i) => i.start)), t1 = Math.max(...its.map((i) => (i.end != null ? i.end : now)));
    const live = its.some((i) => i.status === "running" || i.status === "queued");
    let sum = "";
    if (p.id === "setup") { const bk = its.find((i) => i.kind === "backend"), fd = its.find((i) => i.kind === "deploy");
      sum = [bk && "backend " + dur(len(bk)), fd && (fd.status === "done" ? "first deploy " + dur(len(fd)) : "first deploy " + fd.status)].filter(Boolean).join(" · ") || "waiting"; }
    if (p.id === "dev") { const nd = its.filter((i) => i.kind === "deploy" && i.status === "done"), na = its.filter((i) => i.kind === "agent");
      const nf = its.filter((i) => i.kind === "push").length;
      const med = nd.length ? nd.map(len).sort((a, b) => a - b)[Math.floor(nd.length / 2)] : null;
      sum = [na.length + " agent" + (na.length === 1 ? "" : "s"), nd.length + " deploy" + (nd.length === 1 ? "" : "s") + (med != null ? ", typically " + dur(med) : ""), nf ? nf + " frontend push" + (nf === 1 ? "" : "es") : ""].filter(Boolean).join(" · "); }
    if (p.id === "wind") { const td = its.find((i) => i.kind === "teardown"); sum = td && td.status === "done" ? "backend deleted" : its.every((i) => i.kind !== "teardown" || i.status === "cancelled") ? "restored" : "in grace period"; }
    h += '<details class="phase ' + p.id + '" data-phase="' + p.id + '"' + (CLOSED.has(p.id) ? "" : " open") + '><summary>' +
      '<span class="caret">▶</span><span class="ph-mark"></span><span class="ph-name">' + p.label + '</span>' +
      '<span class="ph-sum">' + sum + '</span><span class="ph-dur">' + (live ? "running · " : "") + dur(t1 - t0) + '</span></summary><ol class="items">';
    for (const it of its) {
      let bar = '<span class="nobar"></span>';
      if (it.bar && it.status !== "skipped") {
        const run = it.status === "running" || it.status === "queued";
        bar = '<span class="bar' + (run ? " run" : "") + '" title="' + esc(dur(len(it))) + '">' + (it.segs
          ? '<i class="w" style="width:' + pct(it.segs.wait) + '"></i><i style="width:' + pct(it.segs.run) + '"></i>' + (it.segs.seed ? '<i class="s" style="width:' + pct(it.segs.seed) + '"></i>' : "")
          : it.runAt ? '<i class="w" style="width:' + pct(it.runAt - it.start) + '"></i><i style="width:' + pct((it.end != null ? it.end : now) - it.runAt) + '"></i>'
          : '<i class="' + (it.status === "queued" ? "w" : "") + '" style="width:' + pct(len(it)) + '"></i>') + '</span>';
      }
      const shown = it.kind === "push" || it.kind === "revived" || it.kind === "other" ? "" : it.kind === "teardown" && it.status !== "done" ? "" : dur(len(it));
      const cells = '<span class="glyph">' + glyphOf(it) + '</span><span class="ttl">' + titleOf(it) + '</span>' + bar +
        '<span class="dur">' + shown + '</span><span class="ago" title="' + esc(new Date(it.start).toLocaleString()) + '">' + ago(it.start) + '</span>';
      const steps = it.steps.length > 1 || (it.steps.length === 1 && it.kind !== "agent");
      if (steps) {
        h += '<li><details class="it st-' + it.status + '" data-key="' + esc(it.key) + '"' + (OPEN.has(it.key) ? " open" : "") + '><summary><span class="caret">▶</span>' + cells + '</summary><ol class="steps">' +
          it.steps.map((st) => '<li><span class="off">+' + dur(Math.max(0, st.at - it.start)) + '</span><span>' + st.text + '</span></li>').join("") + '</ol></details></li>';
      } else {
        h += '<li><div class="it st-' + it.status + '"><div class="line"><span></span>' + cells + '</div></div></li>';
      }
    }
    h += '</ol></details>';
  }
  return h + '</div>';
}

// The lane's resources, linked: branch, PR, web preview, Convex backend.
function laneLinks(l) {
  const a = (href, label, text, extra) => '<a class="link" href="' + esc(href) + '" target="_blank" rel="noopener"><b>' + label + '</b><span class="t">' + text + '</span>' + (extra || '') + '</a>';
  const none = (label, text, href) => href ? '<a class="link none" href="' + esc(href) + '" target="_blank" rel="noopener"><b>' + label + '</b>' + text + '</a>' : '<span class="link none"><b>' + label + '</b>' + text + '</span>';
  let h = '<div class="links">';
  if (l.githubUrl) h += a(l.githubUrl, "Branch", esc(l.branch));
  if (l.pr) h += a(l.pr.url, "PR", "#" + l.pr.number + (l.pr.title ? " " + esc(l.pr.title) : ""), " " + pill(l.pr.state));
  else if (l.newPrUrl) h += none("PR", "none yet · open one", l.newPrUrl);
  h += l.appUrl ? a(l.appUrl, "Preview", esc(l.appUrl.replace(/^https?:\\/\\//, ""))) : none("Preview", "none yet");
  h += l.dashboardUrl ? a(l.dashboardUrl, "Convex", esc(l.deploymentName), ' <span class="sub mono">' + esc((l.deploymentUrl || "").replace(/^https?:\\/\\//, "")) + '</span>') : none("Convex", "not created yet");
  return h + '</div>';
}
function miniLinks(l) {
  const a = (href, text) => '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + text + '</a>';
  return '<span class="minilinks">' + (l.pr ? a(l.pr.url, "PR #" + l.pr.number) : '') + (l.appUrl ? a(l.appUrl, "Preview") : '') + (l.dashboardUrl ? a(l.dashboardUrl, "Convex") : '') + (l.githubUrl ? a(l.githubUrl, "GitHub") : '') + '</span>';
}

function renderLane(v) {
  const l = v.lane, now = Date.now();
  const items = build(v.events);
  const live = l.deployedSha && l.deployedSha === l.headSha;
  const deployState = (l.state === "deleted" || l.state === "archived") ? "" : l.deploying ? pill("deploying", "deploying " + short(l.deploying.sha)) : live ? pill("ready", "live = HEAD") : l.headSha ? pill("waiting", "behind HEAD") : pill("waiting", "nothing pushed");
  let h = '<div class="crumbs sub"><a href="/">Lanes</a> / ' + esc(l.repo) + '</div>';
  const gone = l.state === "archived" || l.state === "deleted";
  const action = l.pool ? "" : gone
    ? '<button class="ghost" data-lane-act="restore" title="' + (l.state === "archived" ? "Same backend, kept during the grace period" : "Its backend was deleted; this makes a new one") + '">Restore</button>'
    : (l.state === "ready" || l.state === "failed") ? '<button class="ghost" data-lane-act="archive">Archive</button>' : "";
  h += '<div class="row"><h1>' + esc(l.branch) + '</h1>' + pill(l.state) + deployState + '<span class="grow"></span>' + action + '</div>';
  h += laneLinks(l);
  // A failed deploy's log lives on its timeline row; up here, one line, and only while the
  // newest deploy is the failed one. A lane that failed to provision shows its first line.
  const deploys = items.filter((i) => i.kind === "deploy");
  const lastDeploy = deploys[deploys.length - 1];
  if (l.state === "failed" && l.error) {
    h += '<details class="banner bad"><summary>Setup failed: ' + esc(String(l.error).split("\\n")[0].slice(0, 200)) + '</summary><pre class="log">' + esc(l.error) + '</pre></details>';
  } else if (lastDeploy && lastDeploy.status === "failed") {
    h += '<p class="banner bad">Last deploy <code>' + esc(short(lastDeploy.sha)) + '</code> failed' +
      (l.deployedSha ? '; the lane still runs <code>' + esc(short(l.deployedSha)) + '</code>' : '') +
      '. <a href="#" data-goto="' + esc(lastDeploy.key) + '">See the error</a></p>';
  }
  // at-a-glance numbers
  const done = items.filter((i) => i.kind === "deploy" && i.status === "done");
  const setup = items.filter((i) => i.phase === "setup");
  const setupEnd = setup.length && setup.every((i) => i.end != null) ? Math.max(...setup.map((i) => i.end)) : null;
  const last = done[done.length - 1];
  const active = v.agents.filter((a) => a.status !== "done").length;
  const stat = (k, val) => '<div class="stat"><b>' + k + '</b><span>' + val + '</span></div>';
  h += '<div class="stats">' + stat("Setup took", setupEnd ? dur(setupEnd - l.createdAt) : "–") + stat("Deploys", String(done.length)) +
    stat("Last deploy", last ? dur(last.end - last.start) : "–") + stat("Running", '<span class="mono">' + short(l.deployedSha) + '</span>') +
    stat("Agents", active + ' <span class="sub">active of ' + v.agents.length + '</span>') + stat("Age", dur(now - l.createdAt)) + '</div>';
  h += '<div class="tlhead"><h2>Timeline</h2><div class="legend"><span><i class="lw" style="background:var(--p-dev)"></i>queued</span><span><i style="background:var(--p-dev)"></i>deploy</span><span><i class="ls" style="background:var(--p-setup)"></i>setup and seed</span></div></div>';
  h += renderTimeline(items);
  const agents = v.agents.slice().sort((a, b) => (a.status === "done") - (b.status === "done") || b.lastSeen - a.lastSeen);
  h += '<h2>Agents</h2><div class="card tablewrap"><table><tr><th>Agent</th><th>Task</th><th>Status</th><th>Who</th><th>Last seen</th><th>Last push</th><th></th></tr>';
  for (const a of agents) {
    const nm = a.name || a.vendor;
    h += '<tr><td><span class="agname">' + avatar(nm) + esc(nm) + '</span></td><td>' + esc(a.task) + '</td><td>' + pill(a.status) + '</td><td class="sub">' + esc(a.vendor) + ' · ' + esc(a.person) + ' · ' + esc(a.machine) +
      '</td><td class="sub">' + ago(a.lastSeen) + '</td><td class="mono">' + short(a.lastSha) + '</td><td>' + (a.threadUrl ? '<a href="' + esc(a.threadUrl) + '" target="_blank">thread</a>' : '') + '</td></tr>';
  }
  if (!agents.length) h += '<tr><td colspan="7" class="sub">No agents yet. Each agent runs <code>lane join --task "…"</code>.</td></tr>';
  h += '</table></div>';
  h += '<h2>Backend</h2><div class="card pad kvs">' +
    '<b>Convex</b>' + (l.deploymentUrl ? '<a href="' + esc(l.dashboardUrl) + '" target="_blank">' + esc(l.deploymentName) + '</a>' : '<span class="sub">none</span>') +
    '<b>Client URL</b><span class="mono">' + esc(l.deploymentUrl || "–") + '</span>' +
    '<b>HTTP actions</b><span class="mono">' + esc(l.siteUrl || "–") + '</span>' +
    '<b>HEAD → running</b><span class="mono">' + short(l.headSha) + ' → ' + short(l.deployedSha) + (l.seeded ? ' <span class="sub">· seeded</span>' : '') + '</span>' +
    '<b>Created</b><span>' + esc(l.createdBy) + ', ' + new Date(l.createdAt).toLocaleString() + '</span></div>';
  $("#app").innerHTML = h;
  for (const d of document.querySelectorAll("details[data-key]")) d.ontoggle = () => { d.open ? OPEN.add(d.dataset.key) : OPEN.delete(d.dataset.key); };
  for (const b of document.querySelectorAll("[data-lane-act]")) b.onclick = async () => {
    const restore = b.dataset.laneAct === "restore";
    if (!restore && !confirm("Archive " + l.branch + "? Its keys are revoked now and its backend is deleted after the grace period. Restore, a push or a reopened PR brings it back.")) return;
    b.disabled = true;
    try {
      await api(restore ? "/api/lane/ensure" : "/api/lane/down", restore ? { repo: l.repo, branch: l.branch } : { repo: l.repo, branch: l.branch, reason: "archived from the lane page" });
      await tick();
    } catch (e) { b.disabled = false; alert(String(e.message || e)); }
  };
  for (const a of document.querySelectorAll("[data-goto]")) a.onclick = (ev) => {
    ev.preventDefault();
    const d = document.querySelector('details[data-key="' + CSS.escape(a.dataset.goto) + '"]');
    if (!d) return;
    const ph = d.closest("details[data-phase]");
    if (ph) ph.open = true;
    d.open = true;
    d.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  for (const d of document.querySelectorAll("details[data-phase]")) d.ontoggle = () => { d.open ? CLOSED.delete(d.dataset.phase) : CLOSED.add(d.dataset.phase); };
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
