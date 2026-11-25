// Data behind the admin panel (/admin). Every function here is internal; the
// HTTP routes in http.ts check that the caller is a lane admin first.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const RESERVED_ENV = /^LANE_/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkPattern(name: string, pattern: string) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`bad env var name ${name}`);
  if (RESERVED_ENV.test(name)) throw new Error(`${name}: LANE_* vars are set by the control plane`);
  new RegExp(`^(?:${pattern})$`); // throws on an invalid pattern
}

/** Tokens with who holds and made them. Hashes and token values never leave the server. */
export const tokens = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("tokens").order("desc").take(500);
    const lastLogin = new Map<string, number>();
    for (const l of await ctx.db.query("logins").order("desc").take(500)) {
      if (!lastLogin.has(l.person)) lastLogin.set(l.person, l.at);
    }
    return rows.map((t) => ({
      id: t._id,
      person: t.person,
      createdAt: t._creationTime,
      createdBy: t.createdBy ?? null,
      revoked: t.revoked,
      revokedBy: t.revokedBy ?? null,
      revokedAt: t.revokedAt ?? null,
      lastSignIn: lastLogin.get(t.person) ?? null,
    }));
  },
});

export const revokeToken = internalMutation({
  args: { id: v.id("tokens"), by: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { id, by }) => {
    const t = await ctx.db.get("tokens", id);
    if (!t || t.revoked) return false;
    await ctx.db.patch("tokens", id, { revoked: true, revokedBy: by, revokedAt: Date.now() });
    return true;
  },
});

/** Repo configs. Env values are secrets (JWT keys), so only their names are returned. */
export const repos = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("repos").take(200);
    const out = [];
    for (const r of rows) {
      const lanes = await ctx.db
        .query("lanes")
        .withIndex("by_repo_and_branch", (q) => q.eq("repo", r.repo))
        .take(500);
      out.push({
        repo: r.repo,
        convexProjectId: r.convexProjectId,
        setupFunctions: r.setupFunctions ?? (r.seedFunction ? [r.seedFunction] : []),
        deployArgs: r.deployArgs ?? [],
        envNames: Object.keys(r.env).sort(),
        laneEnvAllow: r.laneEnvAllow ?? {},
        graceMs: r.graceMs,
        openLanes: lanes.filter((l) => l.state !== "deleted" && l.state !== "archived").length,
      });
    }
    return out.sort((a, b) => a.repo.localeCompare(b.repo));
  },
});

export const addRepo = internalMutation({
  args: { repo: v.string(), convexProjectId: v.number() },
  returns: v.null(),
  handler: async (ctx, { repo, convexProjectId }) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("repo must look like owner/name");
    if (!(Number.isInteger(convexProjectId) && convexProjectId > 0)) throw new Error("Convex project id must be a positive number");
    const existing = await ctx.db
      .query("repos")
      .withIndex("by_repo", (q) => q.eq("repo", repo))
      .unique();
    if (existing) throw new Error(`${repo} is already registered`);
    await ctx.db.insert("repos", {
      repo,
      convexProjectId,
      setupFunctions: [],
      deployArgs: [],
      env: {},
      graceMs: 3 * 24 * 60 * 60_000,
    });
    return null;
  },
});

/** Change any of a repo's settings; fields left out stay as they are. */
export const updateRepo = internalMutation({
  args: {
    repo: v.string(),
    convexProjectId: v.optional(v.number()),
    setupFunctions: v.optional(v.array(v.string())),
    deployArgs: v.optional(v.array(v.string())),
    graceMs: v.optional(v.number()),
    laneEnvAllow: v.optional(v.record(v.string(), v.string())),
  },
  returns: v.null(),
  handler: async (ctx, { repo, ...patch }) => {
    const r = await ctx.db
      .query("repos")
      .withIndex("by_repo", (q) => q.eq("repo", repo))
      .unique();
    if (!r) throw new Error(`${repo} is not registered`);
    if (patch.graceMs !== undefined && !(patch.graceMs >= 0 && patch.graceMs <= 30 * 24 * 60 * 60_000)) {
      throw new Error("grace must be between 0 and 30 days");
    }
    if (patch.convexProjectId !== undefined && !(Number.isInteger(patch.convexProjectId) && patch.convexProjectId > 0)) {
      throw new Error("Convex project id must be a positive number");
    }
    if (patch.setupFunctions?.some((f) => !/^[\w/.-]+:[\w]+$/.test(f))) throw new Error("setup functions look like module:function");
    if (patch.laneEnvAllow) for (const [n, p] of Object.entries(patch.laneEnvAllow)) checkPattern(n, p);
    const clean = Object.fromEntries(Object.entries(patch).filter(([, x]) => x !== undefined));
    if (clean.setupFunctions) await ctx.db.patch("repos", r._id, { seedFunction: undefined });
    await ctx.db.patch("repos", r._id, clean);
    return null;
  },
});

/** Set (value) or remove (null) one env var that every new lane of the repo gets. */
export const setRepoEnv = internalMutation({
  args: { repo: v.string(), name: v.string(), value: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { repo, name, value }) => {
    if (!ENV_NAME.test(name)) throw new Error(`bad env var name ${name}`);
    if (RESERVED_ENV.test(name)) throw new Error(`${name}: LANE_* vars are set by the control plane`);
    const r = await ctx.db
      .query("repos")
      .withIndex("by_repo", (q) => q.eq("repo", repo))
      .unique();
    if (!r) throw new Error(`${repo} is not registered`);
    const env = { ...r.env };
    if (value === null) delete env[name];
    else env[name] = value;
    await ctx.db.patch("repos", r._id, { env });
    return null;
  },
});

/** Recent sign-ins, newest first. */
export const signIns = internalQuery({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("logins").order("desc").take(50)).map((l) => ({ person: l.person, via: l.via, at: l.at })),
});
