import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { sha256Hex } from "./lib/crypto";

/** `npx convex run admin:createToken '{"person":"zen"}'` prints a new token once. */
export const createToken = internalAction({
  args: { person: v.string(), createdBy: v.optional(v.string()) },
  returns: v.string(),
  handler: async (ctx, { person, createdBy }) => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const token = "lane_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    await ctx.runMutation(internal.admin.storeToken, { hash: await sha256Hex(token), person, createdBy });
    return token;
  },
});

export const storeToken = internalMutation({
  args: { hash: v.string(), person: v.string(), createdBy: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("tokens", { ...args, revoked: false });
    return null;
  },
});

export const noteLogin = internalMutation({
  args: { person: v.string(), via: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("logins", { ...args, at: Date.now() });
    return null;
  },
});

export const revokeToken = internalMutation({
  args: { person: v.string() },
  returns: v.number(),
  handler: async (ctx, { person }) => {
    let n = 0;
    for await (const t of ctx.db.query("tokens")) {
      if (t.person === person && !t.revoked) {
        await ctx.db.patch("tokens", t._id, { revoked: true });
        n++;
      }
    }
    return n;
  },
});

export const tokenByHash = internalQuery({
  args: { hash: v.string() },
  handler: async (ctx, { hash }) => {
    const t = await ctx.db
      .query("tokens")
      .withIndex("by_hash", (q) => q.eq("hash", hash))
      .unique();
    return t && !t.revoked ? { person: t.person } : null;
  },
});

/** Allow lanes for a repo. `env` is set on every lane deployment at provisioning. */
export const registerRepo = internalMutation({
  args: {
    repo: v.string(),
    convexProjectId: v.number(),
    seedFunction: v.optional(v.string()),
    setupFunctions: v.optional(v.array(v.string())),
    deployArgs: v.optional(v.array(v.string())),
    env: v.optional(v.record(v.string(), v.string())),
    graceMs: v.optional(v.number()),
    laneEnvAllow: v.optional(v.record(v.string(), v.string())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.laneEnvAllow) checkAllow(args.laneEnvAllow);
    const doc = {
      repo: args.repo,
      convexProjectId: args.convexProjectId,
      seedFunction: args.seedFunction,
      setupFunctions: args.setupFunctions,
      deployArgs: args.deployArgs,
      env: args.env ?? {},
      graceMs: args.graceMs ?? 3 * 24 * 60 * 60_000,
      laneEnvAllow: args.laneEnvAllow,
    };
    const existing = await ctx.db
      .query("repos")
      .withIndex("by_repo", (q) => q.eq("repo", args.repo))
      .unique();
    if (existing) await ctx.db.replace("repos", existing._id, doc);
    else await ctx.db.insert("repos", doc);
    return null;
  },
});

export const setGrace = internalMutation({
  args: { repo: v.string(), graceMs: v.number() },
  returns: v.null(),
  handler: async (ctx, { repo, graceMs }) => {
    const r = await ctx.db
      .query("repos")
      .withIndex("by_repo", (q) => q.eq("repo", repo))
      .unique();
    if (!r) throw new Error(`repo ${repo} is not registered`);
    await ctx.db.patch("repos", r._id, { graceMs });
    return null;
  },
});

function checkAllow(allow: Record<string, string>) {
  for (const [name, pattern] of Object.entries(allow)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`bad env var name ${name}`);
    if (name.startsWith("LANE_")) throw new Error(`${name}: LANE_* vars are set by the control plane`);
    new RegExp(`^(?:${pattern})$`); // throws on an invalid pattern
  }
}

/** Which env vars lanes of this repo may set per lane (name -> value regex, full match). */
export const setLaneEnvAllow = internalMutation({
  args: { repo: v.string(), laneEnvAllow: v.record(v.string(), v.string()) },
  returns: v.null(),
  handler: async (ctx, { repo, laneEnvAllow }) => {
    checkAllow(laneEnvAllow);
    const r = await ctx.db
      .query("repos")
      .withIndex("by_repo", (q) => q.eq("repo", repo))
      .unique();
    if (!r) throw new Error(`repo ${repo} is not registered`);
    await ctx.db.patch("repos", r._id, { laneEnvAllow });
    return null;
  },
});

export const repoConfig = internalQuery({
  args: { repo: v.string() },
  handler: async (ctx, { repo }) => {
    const r = await ctx.db
      .query("repos")
      .withIndex("by_repo", (q) => q.eq("repo", repo))
      .unique();
    if (!r) return null;
    return {
      setupFunctions: r.setupFunctions ?? (r.seedFunction ? [r.seedFunction] : []),
      deployArgs: r.deployArgs ?? [],
      laneEnvAllow: r.laneEnvAllow ?? {},
    };
  },
});
