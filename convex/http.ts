import { httpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { hmacSha256Hex, sha256Hex, timingSafeEqual } from "./lib/crypto";
import { keyWorks, setDeploymentEnv } from "./lib/mgmt";
import { PAGE_HTML } from "./page";
import { ADMIN_HTML } from "./adminPage";

const http = httpRouter();

// ---------------------------------------------------------------- helpers

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function authed(ctx: ActionCtx, req: Request): Promise<string> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "missing bearer token (set LANE_TOKEN)");
  const t = await ctx.runQuery(internal.admin.tokenByHash, { hash: await sha256Hex(token) });
  if (!t) throw new HttpError(401, "invalid or revoked token");
  return t.person;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  let data: unknown;
  try {
    data = await req.json();
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new HttpError(400, "body must be a JSON object");
  }
  return data as Record<string, unknown>;
}

function str(b: Record<string, unknown>, k: string): string {
  const val = b[k];
  if (typeof val !== "string" || val.length === 0 || val.length > 500) {
    throw new HttpError(400, `"${k}" must be a non-empty string`);
  }
  return val;
}

function optStr(b: Record<string, unknown>, k: string): string | undefined {
  return b[k] === undefined || b[k] === null ? undefined : str(b, k);
}

function optMs(b: Record<string, unknown>, k: string): number | undefined {
  const val = b[k];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== "number" || !Number.isFinite(val) || val < 0 || val > 86_400_000) {
    throw new HttpError(400, `"${k}" must be a duration in milliseconds`);
  }
  return Math.round(val);
}

function bool(b: Record<string, unknown>, k: string): boolean {
  return b[k] === true;
}

function route(
  path: string,
  method: "GET" | "POST",
  fn: (ctx: ActionCtx, req: Request) => Promise<unknown>,
) {
  http.route({
    path,
    method,
    handler: httpAction(async (ctx, req) => {
      try {
        return json(await fn(ctx, req));
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        const msg = e instanceof Error ? e.message : String(e);
        return json({ error: msg.replace(/^Uncaught Error: /, "").split("\n")[0] }, 400);
      }
    }),
  });
  http.route({
    path,
    method: "OPTIONS",
    handler: httpAction(async () => new Response(null, { status: 204, headers: CORS })),
  });
}

// ---------------------------------------------------------------- GitHub login
// One GitHub OAuth App per lane-control install. The CLI uses the device flow (no secret on
// laptops); the lane page uses the web flow. Either way GitHub proves who you are, we check
// the allowlist, then mint a normal lane token (stored hashed). GitHub tokens are not kept.

function csv(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
}

async function loginWithGithub(ctx: ActionCtx, accessToken: string, label: string) {
  const gh = (path: string) =>
    fetch("https://api.github.com" + path, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": "lane-control" },
    });
  const me = await gh("/user");
  if (!me.ok) throw new HttpError(401, "GitHub rejected the sign-in");
  const login = String(((await me.json()) as { login?: unknown }).login ?? "");
  if (!login) throw new HttpError(401, "GitHub returned no username");
  const users = csv("LANE_ALLOWED_GITHUB_USERS");
  const orgs = csv("LANE_ALLOWED_GITHUB_ORGS");
  let allowed = users.includes(login.toLowerCase());
  if (!allowed && orgs.length) {
    const res = await gh("/user/orgs?per_page=100");
    const mine = res.ok ? ((await res.json()) as Array<{ login: string }>).map((o) => o.login.toLowerCase()) : [];
    allowed = mine.some((o) => orgs.includes(o));
  }
  if (!allowed) {
    throw new HttpError(
      403,
      `${login} isn't allowed on this lane-control yet. Ask an admin to add you (or your org) under Settings in the Lanes admin panel.`,
    );
  }
  const token: string = await ctx.runAction(internal.admin.createToken, { person: login, createdBy: `github:${login}` });
  await ctx.runMutation(internal.admin.noteLogin, { person: login, via: label });
  return { token, person: login };
}

route("/api/auth/config", "GET", async () => ({
  githubClientId: process.env.GITHUB_CLIENT_ID ?? null,
  webLogin: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
  // Where an admin ticks "Enable Device Flow", which `lane login` needs.
  githubAppSettings: githubAppSettingsUrl(),
}));

function githubAppSettingsUrl() {
  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug) return null;
  const owner = process.env.GITHUB_APP_OWNER ?? "";
  return owner.startsWith("org:")
    ? `https://github.com/organizations/${owner.slice(4)}/settings/apps/${slug}`
    : `https://github.com/settings/apps/${slug}`;
}

// The CLI finished GitHub's device flow and hands us the GitHub token once.
route("/api/auth/github", "POST", async (ctx, req) => {
  const b = await body(req);
  const accessToken = str(b, "accessToken");
  return await loginWithGithub(ctx, accessToken, "cli");
});

async function signState(nonce: string): Promise<string> {
  return nonce + "." + (await hmacSha256Hex(process.env.GITHUB_CLIENT_SECRET ?? "", nonce));
}

http.route({
  path: "/auth/github/start",
  method: "GET",
  handler: httpAction(async (_ctx, req) => {
    if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
      return new Response("GitHub sign-in isn't configured on this lane-control.", { status: 501 });
    }
    // "-admin" in the (signed) nonce sends the browser back to the admin panel afterwards.
    const toAdmin = new URL(req.url).searchParams.get("next") === "admin";
    const nonce =
      Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join("") +
      (toAdmin ? "-admin" : "");
    const u = new URL("https://github.com/login/oauth/authorize");
    u.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID);
    u.searchParams.set("scope", "read:org");
    u.searchParams.set("redirect_uri", `${process.env.CONVEX_SITE_URL}/auth/github/callback`);
    u.searchParams.set("state", await signState(nonce));
    return new Response(null, { status: 302, headers: { Location: u.toString() } });
  }),
});

http.route({
  path: "/auth/github/callback",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const u = new URL(req.url);
    const code = u.searchParams.get("code");
    const state = u.searchParams.get("state") ?? "";
    const nonce = state.split(".")[0] ?? "";
    const fail = (msg: string) =>
      new Response(`<p>Sign-in failed: ${msg.replace(/[<>&]/g, "")}</p><p><a href="/">Back to lanes</a></p>`, {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    if (!code || !nonce || !timingSafeEqual(state, await signState(nonce))) return fail("bad or expired state");
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${process.env.CONVEX_SITE_URL}/auth/github/callback`,
      }),
    });
    const j = (await res.json()) as { access_token?: string; error_description?: string };
    if (!j.access_token) return fail(j.error_description ?? "GitHub didn't return a token");
    try {
      const { token } = await loginWithGithub(ctx, j.access_token, "web");
      // The page reads the token from the fragment, keeps it in localStorage, and strips the URL.
      const back = nonce.endsWith("-admin") ? "/admin" : "/";
      return new Response(null, { status: 302, headers: { Location: `${back}#token=${token}` } });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }),
});

// ---------------------------------------------------------------- pages

const page = httpAction(async () => new Response(PAGE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
http.route({ path: "/", method: "GET", handler: page });
http.route({ path: "/lane", method: "GET", handler: page });
http.route({
  path: "/admin",
  method: "GET",
  handler: httpAction(async () => new Response(ADMIN_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } })),
});

// ---------------------------------------------------------------- admin panel
// Admins are GitHub logins in LANE_ADMIN_GITHUB_USERS. They sign in like anyone else (GitHub on
// the page, or a token minted for their login), and the routes below check the list each call.

function admins(): string[] {
  return csv("LANE_ADMIN_GITHUB_USERS");
}

async function admin(ctx: ActionCtx, req: Request): Promise<string> {
  const person = await authed(ctx, req);
  if (!admins().includes(person.toLowerCase())) {
    throw new HttpError(403, `${person} isn't a Lanes admin. An admin can add you under Settings.`);
  }
  return person;
}

function num(b: Record<string, unknown>, k: string): number {
  const val = b[k];
  if (typeof val !== "number" || !Number.isFinite(val)) throw new HttpError(400, `"${k}" must be a number`);
  return val;
}

function strList(b: Record<string, unknown>, k: string): string[] | undefined {
  const val = b[k];
  if (val === undefined) return undefined;
  if (!Array.isArray(val) || val.some((x) => typeof x !== "string" || x.length === 0 || x.length > 200)) {
    throw new HttpError(400, `"${k}" must be a list of strings`);
  }
  return val as string[];
}

// Public: tells the sign-in screen whether this install has any admins yet (first-run setup).
route("/api/admin/status", "GET", async () => ({
  adminsConfigured: admins().length > 0,
  canClaim: admins().length === 0,
  githubSignIn: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
  siteUrl: process.env.CONVEX_SITE_URL ?? null,
}));

route("/api/admin/me", "GET", async (ctx, req) => {
  const person = await authed(ctx, req);
  return { person, admin: admins().includes(person.toLowerCase()) };
});

route("/api/admin/overview", "GET", async (ctx, req) => {
  const person = await admin(ctx, req);
  const [tokens, repos, lanes, signIns, onboarding, deliveries, convexTeams] = await Promise.all([
    ctx.runQuery(internal.adminPanel.tokens, {}),
    ctx.runQuery(internal.adminPanel.repos, {}),
    ctx.runQuery(internal.lanes.list, { now: Date.now() }),
    ctx.runQuery(internal.adminPanel.signIns, {}),
    ctx.runQuery(internal.adminPanel.onboarding, {}),
    ctx.runQuery(internal.adminPanel.deliveries, {}),
    ctx.runQuery(internal.adminPanel.convexTeams, {}),
  ]);
  return {
    person,
    tokens,
    repos,
    lanes,
    signIns,
    onboarding,
    deliveries,
    convexTeams,
    settings: {
      // Admins edit these from the Settings tab once lane-control holds its own deploy key
      // (saved when the install was claimed); otherwise the tab says how to add it.
      editable: !!process.env.LANE_CONTROL_KEY,
      deployment: selfTarget().name,
      clientIdValue: process.env.GITHUB_CLIENT_ID ?? null, // public by design (it is in the OAuth URL)
      githubApp: process.env.GITHUB_APP_SLUG
        ? { slug: process.env.GITHUB_APP_SLUG, owner: process.env.GITHUB_APP_OWNER ?? null }
        : null,
      admins: admins(),
      allowedUsers: csv("LANE_ALLOWED_GITHUB_USERS"),
      allowedOrgs: csv("LANE_ALLOWED_GITHUB_ORGS"),
      githubSignIn: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
      teamToken: !!process.env.CONVEX_TEAM_TOKEN, // legacy default for repos without a Convex team
      webhookSecret: !!(process.env.GITHUB_WEBHOOK_SECRET || process.env.GITHUB_APP_WEBHOOK_SECRET),
      siteUrl: process.env.CONVEX_SITE_URL ?? null,
    },
  };
});

route("/api/admin/tokens/create", "POST", async (ctx, req) => {
  const by = await admin(ctx, req);
  const b = await body(req);
  const person = str(b, "person");
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(person)) throw new HttpError(400, "name: letters, digits, . _ - (up to 64)");
  // A token named after an admin would carry admin rights; admins get theirs by signing in.
  if (admins().includes(person.toLowerCase())) throw new HttpError(400, `${person} is an admin login; sign in with GitHub instead`);
  const token: string = await ctx.runAction(internal.admin.createToken, { person, createdBy: by });
  return { person, token };
});

route("/api/admin/tokens/revoke", "POST", async (ctx, req) => {
  const by = await admin(ctx, req);
  const b = await body(req);
  const id = str(b, "id") as Id<"tokens">;
  return { revoked: await ctx.runMutation(internal.adminPanel.revokeToken, { id, by }) };
});

route("/api/admin/repos/add", "POST", async (ctx, req) => {
  await admin(ctx, req);
  const b = await body(req);
  await ctx.runMutation(internal.adminPanel.addRepo, {
    repo: str(b, "repo"),
    convexProjectId: num(b, "convexProjectId"),
    convexTeamId: (optStr(b, "convexTeamId") ?? undefined) as Id<"convexTeams"> | undefined,
  });
  return { ok: true };
});

route("/api/admin/repos/update", "POST", async (ctx, req) => {
  await admin(ctx, req);
  const b = await body(req);
  const allow = b.laneEnvAllow;
  if (allow !== undefined && (typeof allow !== "object" || allow === null || Array.isArray(allow) ||
      Object.values(allow).some((x) => typeof x !== "string"))) {
    throw new HttpError(400, '"laneEnvAllow" must be an object of name -> pattern');
  }
  await ctx.runMutation(internal.adminPanel.updateRepo, {
    repo: str(b, "repo"),
    convexProjectId: b.convexProjectId === undefined ? undefined : num(b, "convexProjectId"),
    setupFunctions: strList(b, "setupFunctions"),
    deployArgs: strList(b, "deployArgs"),
    graceMs: b.graceMs === undefined ? undefined : num(b, "graceMs"),
    laneEnvAllow: allow as Record<string, string> | undefined,
    // A team id, null for the default (CONVEX_TEAM_TOKEN), or left out to keep it.
    convexTeamId: b.convexTeamId === undefined ? undefined : ((optStr(b, "convexTeamId") ?? null) as Id<"convexTeams"> | null),
    poolSize: b.poolSize === undefined ? undefined : num(b, "poolSize"),
  });
  return { ok: true };
});

route("/api/admin/repos/env", "POST", async (ctx, req) => {
  await admin(ctx, req);
  const b = await body(req);
  const value = b.value === null ? null : typeof b.value === "string" && b.value.length <= 20_000 ? b.value : undefined;
  if (value === undefined) throw new HttpError(400, '"value" must be a string, or null to remove');
  await ctx.runMutation(internal.adminPanel.setRepoEnv, { repo: str(b, "repo"), name: str(b, "name"), value });
  return { ok: true };
});

route("/api/admin/lanes/archive", "POST", async (ctx, req) => {
  const person = await admin(ctx, req);
  const b = await body(req);
  const res = await ctx.runMutation(internal.lanes.archive, {
    repo: str(b, "repo"),
    branch: str(b, "branch"),
    actor: person,
    reason: "archived from the admin panel",
  });
  return res ?? { alreadyDown: true };
});

route("/api/admin/lanes/retry", "POST", async (ctx, req) => {
  const person = await admin(ctx, req);
  const b = await body(req);
  return await ctx.runMutation(internal.lanes.ensure, { repo: str(b, "repo"), branch: str(b, "branch"), actor: person });
});

// lane-control's own deployment (CONVEX_CLOUD_URL is set on every deployment, cloud or local).
function selfTarget(): { name: string; url: string } {
  const url = (process.env.CONVEX_CLOUD_URL ?? "").replace(/\/$/, "");
  const m = /^https:\/\/([a-z0-9-]+)\.convex\.cloud$/.exec(url);
  return { name: m ? m[1] : "local", url };
}

const NOT_EDITABLE =
  "lane-control doesn't hold its own deploy key yet. Add it under Settings, lane-control, then try again.";

/**
 * Write lane-control's own env vars with its deploy key (LANE_CONTROL_KEY, saved at claim) or a
 * key the caller just pasted. This is lane-control's own credential, separate from the Convex
 * team tokens lanes are created with.
 */
async function writeOwnEnv(vars: Record<string, string | null>, key = process.env.LANE_CONTROL_KEY) {
  if (!key) throw new HttpError(409, NOT_EDITABLE);
  await setDeploymentEnv(selfTarget().url, key, vars);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Uncaught Error: /, "").split("\n")[0] : String(e);
}

const SETTINGS: Record<string, { csv?: boolean; secret?: boolean }> = {
  LANE_ADMIN_GITHUB_USERS: { csv: true },
  LANE_ALLOWED_GITHUB_USERS: { csv: true },
  LANE_ALLOWED_GITHUB_ORGS: { csv: true },
  GITHUB_CLIENT_ID: {},
  GITHUB_CLIENT_SECRET: { secret: true },
  GITHUB_WEBHOOK_SECRET: { secret: true },
};

route("/api/admin/settings", "POST", async (ctx, req) => {
  const person = await admin(ctx, req);
  const b = await body(req);
  const name = str(b, "name");
  const spec = SETTINGS[name];
  if (!spec) throw new HttpError(400, `${name} can't be changed here`);
  let value: string | null;
  let generated: string | undefined;
  if (b.generate === true && name === "GITHUB_WEBHOOK_SECRET") {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    value = generated = Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
  } else if (b.value === null || b.value === "") {
    value = null;
  } else if (typeof b.value === "string" && b.value.length <= 2000) {
    value = b.value.trim();
  } else {
    throw new HttpError(400, '"value" must be a string, or null to remove');
  }
  if (spec.csv && value !== null) {
    const items = value.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (items.some((x) => !/^[a-z0-9-]{1,39}$/.test(x))) throw new HttpError(400, "use GitHub logins or org names, separated by commas");
    value = Array.from(new Set(items)).join(",") || null;
  }
  if (name === "LANE_ADMIN_GITHUB_USERS" && !(value ?? "").split(",").includes(person.toLowerCase())) {
    throw new HttpError(400, `You can't remove yourself as an admin. Ask another admin, or change it in the Convex dashboard.`);
  }
  await writeOwnEnv({ [name]: value });
  return { ok: true, name, set: value !== null, generated };
});

// ---------------------------------------------------------------- setup without a console
// Two separate credentials:
// - Claiming lane-control: paste lane-control's own deploy key (the one its deploy uses). Only
//   someone who can deploy lane-control has it, so it proves ownership. It's saved as
//   LANE_CONTROL_KEY so Settings can change lane-control's env vars later.
// - Creating lanes: each repo is connected to a Convex team with that team's access token
//   (Settings, Convex teams). Different repos can live in different teams.

const DEPLOY_KEY_HELP =
  "Use lane-control's production deploy key: Convex dashboard, the lane-control project, Production, Settings, URL & Deploy Key (the same key as the LANE_CONTROL_DEPLOY_KEY secret).";

route("/api/admin/claim", "POST", async (ctx, req) => {
  if (admins().length) throw new HttpError(409, "This install already has admins. Sign in instead.");
  const b = await body(req);
  const login = str(b, "login").trim().replace(/^@/, "");
  const key = str(b, "deployKey").trim();
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new HttpError(400, "Enter your GitHub username");
  // Prove ownership before reserving anything, so a wrong key never holds up the real owner.
  if (!(await keyWorks(selfTarget().url, key))) throw new HttpError(403, `That key doesn't work on this deployment. ${DEPLOY_KEY_HELP}`);
  if (!(await ctx.runMutation(internal.adminPanel.reserveClaim, { login }))) {
    throw new HttpError(409, "Someone already claimed this install. Ask them to add you as an admin.");
  }
  try {
    await writeOwnEnv({ LANE_ADMIN_GITHUB_USERS: login.toLowerCase(), LANE_CONTROL_KEY: key }, key);
  } catch (e) {
    await ctx.runMutation(internal.adminPanel.releaseClaim, { login });
    throw new HttpError(502, `Couldn't finish setup: ${errMsg(e)}`);
  }
  const token: string = await ctx.runAction(internal.admin.createToken, { person: login, createdBy: "setup" });
  await ctx.runMutation(internal.admin.noteLogin, { person: login, via: "setup" });
  return { person: login, token };
});

// Give lane-control its own deploy key after the fact (installs claimed another way).
route("/api/admin/control-key", "POST", async (ctx, req) => {
  await admin(ctx, req);
  const key = str(await body(req), "deployKey").trim();
  if (!(await keyWorks(selfTarget().url, key))) throw new HttpError(403, `That key doesn't work on this deployment. ${DEPLOY_KEY_HELP}`);
  await writeOwnEnv({ LANE_CONTROL_KEY: key }, key);
  return { ok: true };
});

const TEAM_TOKEN_HELP = "Create one in the Convex dashboard: Team settings, Access tokens, in the team the repo's project lives in.";

// Connect a Convex team (where lanes are created). Pasting a token for a team that is already
// connected replaces its token.
route("/api/admin/convex/teams/add", "POST", async (ctx, req) => {
  const person = await admin(ctx, req);
  const b = await body(req);
  const token = str(b, "token").trim();
  let info: { teamId: number; projects: Array<{ id: number; name: string; slug: string }> };
  try {
    info = await ctx.runAction(internal.provision.inspectToken, { token });
  } catch (e) {
    const msg = errMsg(e);
    if (/-> (400|401|403|404):/.test(msg)) throw new HttpError(403, `Convex didn't accept that token. ${TEAM_TOKEN_HELP}`);
    throw new HttpError(502, msg);
  }
  const label = (optStr(b, "label") ?? "").trim().slice(0, 60) || `Team ${info.teamId}`;
  const id = await ctx.runMutation(internal.adminPanel.addConvexTeam, { label, teamId: info.teamId, token, by: person });
  return { id, teamId: info.teamId, label, projects: info.projects };
});

route("/api/admin/convex/teams/remove", "POST", async (ctx, req) => {
  await admin(ctx, req);
  await ctx.runMutation(internal.adminPanel.removeConvexTeam, { id: str(await body(req), "id") as Id<"convexTeams"> });
  return { ok: true };
});

// Projects for the repo form: a connected team's, or the legacy CONVEX_TEAM_TOKEN's.
route("/api/admin/convex/projects", "GET", async (ctx, req) => {
  await admin(ctx, req);
  const team = new URL(req.url).searchParams.get("team");
  return { projects: await ctx.runAction(internal.provision.projects, { teamId: (team || undefined) as Id<"convexTeams"> | undefined }) };
});

// One-click GitHub: lane-control hands the browser a GitHub App manifest; GitHub creates the app
// (OAuth sign-in, webhook to /github/webhook with a fresh secret, push + PR events) and redirects
// to /admin/github/created, which stores the app's credentials as lane-control env vars.
function siteUrl(): string {
  return process.env.CONVEX_SITE_URL ?? "";
}

route("/api/admin/github/manifest", "POST", async (ctx, req) => {
  const person = await admin(ctx, req);
  if (!process.env.LANE_CONTROL_KEY) throw new HttpError(409, NOT_EDITABLE);
  const b = await body(req);
  const org = typeof b.org === "string" && b.org.trim() ? b.org.trim() : null;
  if (org && !/^[A-Za-z0-9-]{1,39}$/.test(org)) throw new HttpError(400, "That isn't a GitHub org name");
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join("");
  await ctx.runMutation(internal.adminPanel.startGithubApp, { state, by: person });
  const site = siteUrl();
  const name = ("Lanes " + selfTarget().name).slice(0, 34);
  const manifest = {
    name,
    url: site + "/admin",
    description: "Per-branch backends (lanes). Created by lane-control at " + site,
    hook_attributes: { url: site + "/github/webhook", active: true },
    redirect_url: site + "/admin/github/created",
    callback_urls: [site + "/auth/github/callback"],
    public: false,
    default_permissions: { metadata: "read", contents: "read", pull_requests: "read", members: "read" },
    default_events: ["push", "pull_request"],
  };
  const base = org ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new` : "https://github.com/settings/apps/new";
  return { action: `${base}?state=${state}`, manifest: JSON.stringify(manifest) };
});

http.route({
  path: "/admin/github/created",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const u = new URL(req.url);
    const code = u.searchParams.get("code") ?? "";
    const state = u.searchParams.get("state") ?? "";
    const back = (q: string) => new Response(null, { status: 302, headers: { Location: `/admin#tab=start&${q}` } });
    const by = state ? await ctx.runMutation(internal.adminPanel.finishGithubApp, { state }) : null;
    if (!by || !/^[\w-]{1,100}$/.test(code)) {
      return back("error=" + encodeURIComponent("That GitHub app link expired. Start again from Get started."));
    }
    try {
      const gh = process.env.LANE_GITHUB_API_URL ?? "https://api.github.com";
      const res = await fetch(`${gh}/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: "POST",
        headers: { Accept: "application/vnd.github+json", "User-Agent": "lane-control" },
      });
      const app = (await res.json()) as {
        slug?: string; client_id?: string; client_secret?: string; webhook_secret?: string; html_url?: string;
        owner?: { login?: string; type?: string }; message?: string;
      };
      if (!res.ok || !app.client_id || !app.client_secret || !app.slug) throw new Error(app.message ?? `GitHub returned ${res.status}`);
      const owner = app.owner?.login ?? "";
      const ownerIsOrg = app.owner?.type === "Organization";
      const vars: Record<string, string> = {
        GITHUB_CLIENT_ID: app.client_id,
        GITHUB_CLIENT_SECRET: app.client_secret,
        GITHUB_APP_SLUG: app.slug,
        GITHUB_APP_OWNER: (ownerIsOrg ? "org:" : "user:") + owner,
      };
      if (app.webhook_secret) vars.GITHUB_APP_WEBHOOK_SECRET = app.webhook_secret; // hand-added webhooks keep theirs
      // Let the app's owner in by default: the org's members, or (for a personal app) the person.
      if (ownerIsOrg && !csv("LANE_ALLOWED_GITHUB_ORGS").length) vars.LANE_ALLOWED_GITHUB_ORGS = owner.toLowerCase();
      if (!ownerIsOrg && owner && !csv("LANE_ALLOWED_GITHUB_USERS").length) vars.LANE_ALLOWED_GITHUB_USERS = owner.toLowerCase();
      await writeOwnEnv(vars);
      return back("github=created");
    } catch (e) {
      return back("error=" + encodeURIComponent("Couldn't finish connecting GitHub: " + errMsg(e)));
    }
  }),
});

// ---------------------------------------------------------------- lanes

route("/api/whoami", "GET", async (ctx, req) => ({ person: await authed(ctx, req) }));

route("/api/repo", "GET", async (ctx, req) => {
  await authed(ctx, req);
  const repo = new URL(req.url).searchParams.get("repo");
  if (!repo) throw new HttpError(400, "repo is required");
  const cfg = await ctx.runQuery(internal.admin.repoConfig, { repo });
  return { repo, registered: cfg !== null };
});

// Warm-pool spares for a repo: `lane pool` shows them, `lane pool fill` deploys to them.
route("/api/pool", "GET", async (ctx, req) => {
  await authed(ctx, req);
  const repo = new URL(req.url).searchParams.get("repo");
  if (!repo) throw new HttpError(400, "repo is required");
  return await ctx.runQuery(internal.pool.list, { repo });
});

route("/api/lanes", "GET", async (ctx, req) => {
  await authed(ctx, req);
  return await ctx.runQuery(internal.lanes.list, { now: Date.now() });
});

route("/api/lane", "GET", async (ctx, req) => {
  await authed(ctx, req);
  const u = new URL(req.url);
  const repo = u.searchParams.get("repo");
  const branch = u.searchParams.get("branch");
  if (!repo || !branch) throw new HttpError(400, "repo and branch are required");
  const view = await ctx.runQuery(internal.lanes.view, { repo, branch, now: Date.now() });
  if (!view) throw new HttpError(404, `no lane for ${repo}@${branch}`);
  return view;
});

route("/api/lane/ensure", "POST", async (ctx, req) => {
  const person = await authed(ctx, req);
  const b = await body(req);
  return await ctx.runMutation(internal.lanes.ensure, {
    repo: str(b, "repo"),
    branch: str(b, "branch"),
    headSha: optStr(b, "headSha"),
    actor: person,
  });
});

route("/api/lane/push", "POST", async (ctx, req) => {
  const person = await authed(ctx, req);
  const b = await body(req);
  return await ctx.runMutation(internal.lanes.push, {
    repo: str(b, "repo"),
    branch: str(b, "branch"),
    sha: str(b, "sha"),
    convexChanged: bool(b, "convexChanged"),
    actor: optStr(b, "actor") ?? person,
  });
});

route("/api/lane/down", "POST", async (ctx, req) => {
  const person = await authed(ctx, req);
  const b = await body(req);
  const res = await ctx.runMutation(internal.lanes.archive, {
    repo: str(b, "repo"),
    branch: str(b, "branch"),
    actor: person,
    reason: optStr(b, "reason") ?? "lane down",
  });
  return res ?? { alreadyDown: true };
});

route("/api/lane/key", "POST", async (ctx, req) => {
  const person = await authed(ctx, req);
  const b = await body(req);
  const info = await ctx.runQuery(internal.lanes.laneIdFor, { repo: str(b, "repo"), branch: str(b, "branch") });
  if (!info || info.state !== "ready" || !info.deploymentName) throw new HttpError(409, "lane is not ready");
  const minted = await ctx.runAction(internal.provision.mintKey, {
    laneId: info.laneId,
    deploymentName: info.deploymentName,
    holder: optStr(b, "holder") ?? person,
    purpose: "agent",
  });
  return minted;
});

// A 31-minute key that can import and replace the lane's data, for `lane reset`: emptying tables
// that block a schema change, or restoring the repo's seed snapshot. Logged on the lane.
route("/api/lane/reset-key", "POST", async (ctx, req) => {
  const person = await authed(ctx, req);
  const b = await body(req);
  const repo = str(b, "repo");
  const branch = str(b, "branch");
  if (branch.startsWith("pool:")) throw new HttpError(400, "warm-pool spares can't be reset");
  const info = await ctx.runQuery(internal.lanes.laneIdFor, { repo, branch });
  if (!info || info.state !== "ready" || !info.deploymentName) throw new HttpError(409, "lane is not ready");
  const holder = optStr(b, "holder") ?? person;
  const minted = await ctx.runAction(internal.provision.mintKey, {
    laneId: info.laneId,
    deploymentName: info.deploymentName,
    holder,
    purpose: "seed",
  });
  await ctx.runMutation(internal.lanes.logLaneEvent, {
    repo,
    branch,
    type: "reset",
    detail: optStr(b, "detail") ?? "data reset",
    actor: holder,
  });
  return { ...minted, snapshot: await ctx.runQuery(internal.seed.latest, { repo }) };
});

route("/api/lane/event", "POST", async (ctx, req) => {
  const person = await authed(ctx, req);
  const b = await body(req);
  await ctx.runMutation(internal.lanes.logLaneEvent, {
    repo: str(b, "repo"),
    branch: str(b, "branch"),
    type: str(b, "type"),
    detail: str(b, "detail"),
    actor: optStr(b, "actor") ?? person,
  });
  return { ok: true };
});

route("/api/lane/env", "POST", async (ctx, req) => {
  const person = await authed(ctx, req);
  const b = await body(req);
  const repo = str(b, "repo");
  const branch = str(b, "branch");
  const raw = b.vars;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.keys(raw).length === 0) {
    throw new HttpError(400, '"vars" must be a non-empty object of name -> value');
  }
  const t = await ctx.runQuery(internal.lanes.envTarget, { repo, branch });
  if (!t) throw new HttpError(404, "no lane for this branch");
  if (t.state !== "ready" || !t.deploymentName || !t.deploymentUrl) throw new HttpError(409, "lane is not ready");
  const vars: Record<string, string> = {};
  for (const name of Object.keys(raw)) {
    const value = str(raw as Record<string, unknown>, name);
    const pattern = t.allow[name];
    if (pattern === undefined) throw new HttpError(403, `${name} is not settable per lane for ${repo}`);
    if (!new RegExp(`^(?:${pattern})$`).test(value)) throw new HttpError(400, `${name} value is not allowed`);
    if (t.env[name] !== value) vars[name] = value;
  }
  if (Object.keys(vars).length === 0) return { changed: [] };
  await ctx.runAction(internal.provision.setLaneEnv, {
    deploymentName: t.deploymentName,
    deploymentUrl: t.deploymentUrl,
    vars,
    repo,
  });
  const ok = await ctx.runMutation(internal.lanes.recordEnv, {
    laneId: t.laneId,
    deploymentName: t.deploymentName,
    vars,
    actor: optStr(b, "actor") ?? person,
  });
  if (!ok) throw new HttpError(409, "lane changed while setting env; retry");
  return { changed: Object.keys(vars).sort() };
});

// ---------------------------------------------------------------- deployer

route("/api/deploy/claim", "POST", async (ctx, req) => {
  const person = await authed(ctx, req);
  const b = await body(req);
  const repo = str(b, "repo");
  const holder = optStr(b, "holder") ?? person;
  const claim = await ctx.runMutation(internal.lanes.claimDeploy, {
    repo,
    branch: str(b, "branch"),
    holder,
    force: bool(b, "force"),
  });
  if (claim.status !== "claimed") return claim;
  const minted = await ctx.runAction(internal.provision.mintKey, {
    laneId: claim.laneId,
    deploymentName: claim.deploymentName,
    holder,
    purpose: "deployer",
  });
  const cfg = await ctx.runQuery(internal.admin.repoConfig, { repo });
  // A first deploy can import the repo's seed snapshot instead of running the setup functions.
  // Its key is separate and optional: without it the deployer just runs the setup functions.
  let snapshot = null;
  let seedKey: string | null = null;
  if (claim.needSeed) {
    snapshot = await ctx.runQuery(internal.seed.latest, { repo });
    try {
      seedKey = (await ctx.runAction(internal.provision.mintKey, {
        laneId: claim.laneId,
        deploymentName: claim.deploymentName,
        holder,
        purpose: "seed",
      })).key;
    } catch (e) {
      console.warn(`no seed key for ${repo}: ${errMsg(e)}`);
    }
  }
  return {
    status: claim.status,
    sha: claim.sha,
    deployKey: minted.key,
    needSeed: claim.needSeed,
    setupFunctions: claim.needSeed ? cfg?.setupFunctions ?? [] : [],
    deployArgs: cfg?.deployArgs ?? [],
    snapshot,
    seedKey,
  };
});

// Seed snapshots: the deployer uploads a fresh lane's export (upload URL, then record it).
route("/api/seed/upload-url", "POST", async (ctx, req) => {
  await authed(ctx, req);
  return { url: await ctx.storage.generateUploadUrl() };
});

route("/api/seed/snapshot", "POST", async (ctx, req) => {
  const person = await authed(ctx, req);
  const b = await body(req);
  await ctx.runMutation(internal.seed.record, {
    repo: str(b, "repo"),
    sha: str(b, "sha"),
    tree: optStr(b, "tree"),
    storageId: str(b, "storageId") as Id<"_storage">,
    setupMs: optMs(b, "setupMs"),
    createdBy: optStr(b, "holder") ?? person,
  });
  return { ok: true };
});

route("/api/seed/import", "POST", async (ctx, req) => {
  await authed(ctx, req);
  const b = await body(req);
  const importMs = optMs(b, "importMs");
  if (importMs === undefined) throw new HttpError(400, "importMs is required");
  await ctx.runMutation(internal.seed.recordImport, { repo: str(b, "repo"), sha: str(b, "sha"), importMs });
  return { ok: true };
});

route("/api/seed/latest", "GET", async (ctx, req) => {
  await authed(ctx, req);
  const repo = new URL(req.url).searchParams.get("repo");
  if (!repo) throw new HttpError(400, "repo is required");
  return { snapshot: await ctx.runQuery(internal.seed.latest, { repo }) };
});

route("/api/deploy/finish", "POST", async (ctx, req) => {
  const person = await authed(ctx, req);
  const b = await body(req);
  return await ctx.runMutation(internal.lanes.finishDeploy, {
    repo: str(b, "repo"),
    branch: str(b, "branch"),
    holder: optStr(b, "holder") ?? person,
    sha: str(b, "sha"),
    ok: bool(b, "ok"),
    seeded: bool(b, "seeded"),
    detail: typeof b.detail === "string" ? b.detail.slice(0, 2000) : "",
  });
});

// ---------------------------------------------------------------- agents

route("/api/agents/join", "POST", async (ctx, req) => {
  const person = await authed(ctx, req);
  const b = await body(req);
  const repo = str(b, "repo");
  const branch = str(b, "branch");
  const joined = await ctx.runMutation(internal.lanes.join, {
    repo,
    branch,
    vendor: str(b, "vendor"),
    person: optStr(b, "person") ?? person,
    task: str(b, "task"),
    machine: optStr(b, "machine") ?? "unknown",
    threadUrl: optStr(b, "threadUrl"),
    agentId: optStr(b, "agentId") as Id<"laneAgents"> | undefined,
  });
  return joined;
});

route("/api/agents/heartbeat", "POST", async (ctx, req) => {
  await authed(ctx, req);
  const b = await body(req);
  const status = str(b, "status");
  if (status !== "working" && status !== "waiting" && status !== "done") {
    throw new HttpError(400, "status must be working, waiting or done");
  }
  await ctx.runMutation(internal.lanes.heartbeat, {
    agentId: str(b, "agentId") as Id<"laneAgents">,
    status,
    task: optStr(b, "task"),
    lastSha: optStr(b, "lastSha"),
  });
  return { ok: true };
});

// ---------------------------------------------------------------- GitHub

http.route({
  path: "/github/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const event = req.headers.get("x-github-event") ?? "unknown";
    let repo: string | undefined;
    // Every delivery is logged (event, repo, outcome) so the admin panel can say whether
    // GitHub is connected and, if not, why.
    const done = async (status: number, data: unknown, note: string) => {
      await ctx.runMutation(internal.adminPanel.logDelivery, { event, repo, ok: status < 300, note });
      return json(data, status);
    };
    // Two senders: the GitHub app Lanes created (GITHUB_APP_WEBHOOK_SECRET) and webhooks added
    // by hand (GITHUB_WEBHOOK_SECRET). Either secret is accepted.
    const secrets = [process.env.GITHUB_APP_WEBHOOK_SECRET, process.env.GITHUB_WEBHOOK_SECRET].filter((x): x is string => !!x);
    const raw = await req.text();
    const sig = req.headers.get("x-hub-signature-256") ?? "";
    if (!secrets.length) return await done(401, { error: "webhooks are not set up" }, "Refused: GitHub isn't connected yet (no webhook secret on lane-control)");
    let signed = false;
    for (const secret of secrets) if (timingSafeEqual(sig, "sha256=" + (await hmacSha256Hex(secret, raw)))) signed = true;
    if (!signed) {
      return await done(401, { error: "bad signature" }, "Refused: the delivery's secret doesn't match lane-control's webhook secret");
    }
    let p: Record<string, any>;
    try {
      p = JSON.parse(raw);
    } catch {
      return await done(400, { error: "bad json" }, "Refused: body isn't JSON (set the content type to application/json)");
    }
    if (typeof p.repository?.full_name === "string") repo = p.repository.full_name;
    if (event === "ping") return await done(200, { ok: true }, "Webhook connected");
    if (!repo) return await done(200, { ignored: "no repository" }, "Ignored: no repository in the payload");
    const registered = await ctx.runQuery(internal.admin.repoConfig, { repo });
    if (!registered) return await done(200, { ignored: "repo not registered" }, `Ignored: ${repo} isn't registered on lane-control`);
    try {
      if (event === "push" && typeof p.ref === "string" && p.ref.startsWith("refs/heads/")) {
        const branch = p.ref.slice("refs/heads/".length);
        if (p.deleted === true) {
          const res = await ctx.runMutation(internal.lanes.archive, { repo, branch, actor: "github", reason: "branch deleted" });
          return await done(200, res, `Branch ${branch} deleted: lane archived`);
        }
        const commits: Array<Record<string, unknown>> = Array.isArray(p.commits) ? p.commits : [];
        const touched = commits.flatMap((c) =>
          ["added", "modified", "removed"].flatMap((k) => (Array.isArray(c[k]) ? (c[k] as string[]) : [])),
        );
        // GitHub truncates commit lists past 20 commits; treat that as "maybe changed".
        const convexChanged = commits.length >= 20 || touched.some((f) => f.startsWith("convex/"));
        const res = await ctx.runMutation(internal.lanes.push, {
          repo,
          branch,
          sha: String(p.after),
          convexChanged,
          actor: `github/${p.pusher?.name ?? "unknown"}`,
        });
        // The lane deployer (a GitHub Action on the same push) does the deploy itself.
        return await done(200, res, res.lane ? `Push to ${branch} (${String(p.after).slice(0, 7)}) recorded` : `Push to ${branch}: no lane for this branch (lanes start when a PR opens)`);
      }
      if (event === "pull_request") {
        const branch: unknown = p.pull_request?.head?.ref;
        if (typeof branch !== "string") return await done(200, { ignored: "no head ref" }, "Ignored: pull request without a head branch");
        if (p.action === "opened" || p.action === "reopened") {
          const res = await ctx.runMutation(internal.lanes.ensure, {
            repo,
            branch,
            headSha: p.pull_request?.head?.sha,
            actor: `github/${p.sender?.login ?? "unknown"}`,
          });
          return await done(200, res, `PR ${p.action} on ${branch}: lane ${res.created ? "created" : "kept"}`);
        }
        if (p.action === "closed") {
          const merged = !!p.pull_request?.merged;
          const res = await ctx.runMutation(internal.lanes.archive, {
            repo,
            branch,
            actor: `github/${p.sender?.login ?? "unknown"}`,
            reason: merged ? "PR merged" : "PR closed",
          });
          return await done(200, res, `PR ${merged ? "merged" : "closed"} on ${branch}: lane ${res ? "archived" : "already down"}`);
        }
        return await done(200, { ignored: p.action }, `Ignored: pull request ${p.action}`);
      }
      return await done(200, { ignored: event }, `Ignored: ${event} events aren't used`);
    } catch (e) {
      const msg = e instanceof Error ? e.message.replace(/^Uncaught Error: /, "").split("\n")[0] : String(e);
      return await done(500, { error: msg }, `Failed: ${msg}`);
    }
  }),
});

export default http;
