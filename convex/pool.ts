// Warm pool: spare lanes per repo, already deployed from the default branch and seeded, so a
// new lane claims one in a single transaction instead of waiting for a cold create, deploy
// and seed. Spares are ordinary lane rows with `pool: true` and branch "pool:<id>"; the
// control plane creates their deployments, and `lane pool fill` (run by CI on pushes to the
// default branch) deploys and seeds them like any other lane.
import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

export const POOL_PREFIX = "pool:";
const MAX_POOL = 10;

async function logEvent(ctx: MutationCtx, laneId: Id<"lanes">, type: string, actor: string, detail: string) {
  await ctx.db.insert("laneEvents", { laneId, type, actor, detail, at: Date.now() });
}

async function spares(ctx: QueryCtx, repo: string) {
  return await ctx.db
    .query("lanes")
    .withIndex("by_repo_and_pool", (q) => q.eq("repo", repo).eq("pool", true))
    .take(50);
}

/** A spare that is deployed, seeded and not mid-deploy, oldest first; null when none. */
async function readySpare(ctx: MutationCtx, repo: string): Promise<Doc<"lanes"> | null> {
  const now = Date.now();
  const ready = (await spares(ctx, repo)).filter(
    (l) => l.state === "ready" && l.seeded && l.deployedSha && l.deploymentName && !(l.lock && l.lock.expiresAt > now),
  );
  ready.sort((a, b) => a.createdAt - b.createdAt);
  return ready[0] ?? null;
}

/**
 * Hand a ready spare to `branch`. With `into`, the spare's deployment moves into that existing
 * (deleted or failed) lane row and the spare row goes away; otherwise the spare row becomes the
 * lane. Returns the lane id, or null when no spare is ready (the caller starts cold).
 */
export async function claimSpare(
  ctx: MutationCtx,
  args: { repo: string; branch: string; actor: string; into?: Doc<"lanes"> },
): Promise<Id<"lanes"> | null> {
  const spare = await readySpare(ctx, args.repo);
  if (!spare) return null;
  const now = Date.now();
  const fields = {
    state: "ready" as const,
    deploymentName: spare.deploymentName,
    deploymentUrl: spare.deploymentUrl,
    siteUrl: spare.siteUrl,
    deployedSha: spare.deployedSha,
    seeded: true,
    // The lane starts at what the spare runs; the branch's own head then arrives as a push,
    // which deploys only when convex/ differs (a frontend-only branch is live immediately).
    headSha: spare.deployedSha,
    headConvexChanged: undefined,
    error: undefined,
    lock: undefined,
    createdBy: args.actor,
    createdAt: now,
    readyAt: now,
    lastActivity: now,
  };
  let laneId: Id<"lanes">;
  if (args.into) {
    laneId = args.into._id;
    await ctx.db.patch("lanes", laneId, { ...fields, env: args.into.env });
    // Keys minted while the spare was filled are revoked with the lane they now belong to.
    for (const k of await ctx.db.query("laneKeys").withIndex("by_laneId", (q) => q.eq("laneId", spare._id)).take(500)) {
      await ctx.db.patch("laneKeys", k._id, { laneId });
    }
    for (const e of await ctx.db.query("laneEvents").withIndex("by_laneId", (q) => q.eq("laneId", spare._id)).take(500)) {
      await ctx.db.delete("laneEvents", e._id);
    }
    await ctx.db.delete("lanes", spare._id);
  } else {
    laneId = spare._id;
    await ctx.db.patch("lanes", laneId, { ...fields, branch: args.branch, pool: undefined, env: undefined });
  }
  await logEvent(
    ctx,
    laneId,
    "ready",
    "control-plane",
    `claimed a warm spare (${spare.deploymentName}, seeded, running ${spare.deployedSha!.slice(0, 7)})`,
  );
  // The deployment still says it belongs to the spare.
  const lane = (await ctx.db.get("lanes", laneId))!;
  await ctx.scheduler.runAfter(0, internal.provision.setLaneEnv, {
    deploymentName: spare.deploymentName!,
    deploymentUrl: spare.deploymentUrl!,
    vars: { ...(lane.env ?? {}), LANE_BRANCH: args.branch },
    repo: args.repo,
  });
  await ctx.scheduler.runAfter(0, internal.provision.renameForBranch, {
    deploymentName: spare.deploymentName!,
    branch: args.branch,
    repo: args.repo,
  });
  await ctx.scheduler.runAfter(0, internal.pool.refill, { repo: args.repo });
  return laneId;
}

/** Create spares until each pooled repo has `poolSize` of them (counting ones being built). */
export const refill = internalMutation({
  args: { repo: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { repo }) => {
    const repos = repo
      ? await ctx.db.query("repos").withIndex("by_repo", (q) => q.eq("repo", repo)).take(1)
      : await ctx.db.query("repos").take(200);
    for (const cfg of repos) {
      const want = Math.min(cfg.poolSize ?? 0, MAX_POOL);
      const all = await spares(ctx, cfg.repo);
      // A spare that failed to provision is replaced, not retried; it holds no deployment.
      for (const l of all.filter((l) => l.state === "failed")) await ctx.db.patch("lanes", l._id, { state: "deleted" });
      const live = all.filter((l) => l.state === "provisioning" || l.state === "ready");
      for (let i = live.length; i < want; i++) {
        const now = Date.now();
        const id = `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const laneId = await ctx.db.insert("lanes", {
          repo: cfg.repo,
          branch: POOL_PREFIX + id,
          pool: true,
          state: "provisioning",
          seeded: false,
          createdBy: "control-plane",
          createdAt: now,
          lastActivity: now,
        });
        await logEvent(ctx, laneId, "provisioning", "control-plane", "warm-pool spare");
        await ctx.scheduler.runAfter(0, internal.provision.provision, { laneId });
      }
    }
    return null;
  },
});

/** The repo's spares, for `lane pool` and the deployer that fills them. */
export const list = internalQuery({
  args: { repo: v.string() },
  handler: async (ctx, { repo }) => {
    const cfg = await ctx.db.query("repos").withIndex("by_repo", (q) => q.eq("repo", repo)).unique();
    return {
      poolSize: cfg?.poolSize ?? 0,
      spares: (await spares(ctx, repo))
        .filter((l) => l.state !== "deleted")
        .map((l) => ({
          branch: l.branch,
          state: l.state,
          deploymentName: l.deploymentName ?? null,
          deployedSha: l.deployedSha ?? null,
          seeded: l.seeded,
          deploying: l.lock ? l.lock.sha : null,
          error: l.error ?? null,
          createdAt: l.createdAt,
        })),
    };
  },
});
