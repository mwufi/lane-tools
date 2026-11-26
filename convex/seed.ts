// Snapshot seeding: instead of running a repo's setup functions on every new lane, import the
// newest seed snapshot (a ZIP from `npx convex export` of a freshly seeded lane). The deployer
// falls back to the setup functions if there is none or the import fails.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const KEEP = 2;

export const latest = internalQuery({
  args: { repo: v.string() },
  handler: async (ctx, { repo }) => {
    const s = await ctx.db
      .query("seedSnapshots")
      .withIndex("by_repo", (q) => q.eq("repo", repo))
      .order("desc")
      .first();
    if (!s) return null;
    const url = await ctx.storage.getUrl(s.storageId);
    if (!url) return null;
    return {
      sha: s.sha,
      tree: s.tree ?? null,
      bytes: s.bytes,
      at: s.at,
      createdBy: s.createdBy,
      setupMs: s.setupMs ?? null,
      importMs: s.importMs ?? null,
      url,
    };
  },
});

export const record = internalMutation({
  args: {
    repo: v.string(),
    sha: v.string(),
    tree: v.optional(v.string()),
    storageId: v.id("_storage"),
    setupMs: v.optional(v.number()),
    createdBy: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const repoCfg = await ctx.db.query("repos").withIndex("by_repo", (q) => q.eq("repo", args.repo)).unique();
    if (!repoCfg) throw new Error(`repo ${args.repo} is not registered for lanes`);
    const meta = await ctx.db.system.get("_storage", args.storageId);
    if (!meta) throw new Error("upload not found");
    await ctx.db.insert("seedSnapshots", { ...args, bytes: meta.size, at: Date.now() });
    const all = await ctx.db
      .query("seedSnapshots")
      .withIndex("by_repo", (q) => q.eq("repo", args.repo))
      .order("desc")
      .take(50);
    for (const old of all.slice(KEEP)) {
      if (await ctx.db.system.get("_storage", old.storageId)) await ctx.storage.delete(old.storageId);
      await ctx.db.delete("seedSnapshots", old._id);
    }
    return null;
  },
});

// The deployer reports how long an import of the repo's newest snapshot took.
export const recordImport = internalMutation({
  args: { repo: v.string(), sha: v.string(), importMs: v.number() },
  returns: v.null(),
  handler: async (ctx, { repo, sha, importMs }) => {
    const s = await ctx.db
      .query("seedSnapshots")
      .withIndex("by_repo", (q) => q.eq("repo", repo))
      .order("desc")
      .first();
    if (s && s.sha === sha) await ctx.db.patch("seedSnapshots", s._id, { importMs });
    return null;
  },
});
