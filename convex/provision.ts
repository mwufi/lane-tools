import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  AGENT_ACTIONS,
  DEPLOYER_ACTIONS,
  createDeployKey,
  createDeployment,
  deleteDeployKey,
  deleteDeployment,
  setDeploymentEnv,
  siteUrlFor,
} from "./lib/mgmt";

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
}

/** Convex resource type, `ensure`: create a dev deployment and set the lane env. */
export const provision = internalAction({
  args: { laneId: v.id("lanes") },
  returns: v.null(),
  handler: async (ctx, { laneId }) => {
    const started = Date.now();
    const data = await ctx.runQuery(internal.lanes.getForProvision, { laneId });
    if (!data || !data.repoCfg || data.lane.state !== "provisioning") return null;
    const { lane, repoCfg } = data;
    try {
      const reference = `lane-${slug(lane.branch)}-${Date.now().toString(36)}`;
      const dep = await createDeployment(repoCfg.convexProjectId, reference);
      const env = { ...repoCfg.env, LANE_REPO: lane.repo, LANE_BRANCH: lane.branch };
      // A 31-minute key used once for env setup, then deleted.
      const setupKeyName = `lane-setup-${Date.now().toString(36)}`;
      const setupKey = await createDeployKey(
        dep.name,
        setupKeyName,
        ["deployment:env:write", "deployment:env:view"],
        0,
      );
      await setDeploymentEnv(dep.deploymentUrl, setupKey, env);
      await deleteDeployKey(dep.name, setupKeyName);
      await ctx.runMutation(internal.lanes.markProvisioned, {
        laneId,
        deploymentName: dep.name,
        deploymentUrl: dep.deploymentUrl,
        siteUrl: siteUrlFor(dep.deploymentUrl),
        tookMs: Date.now() - started,
      });
    } catch (e) {
      await ctx.runMutation(internal.lanes.markFailed, {
        laneId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return null;
  },
});

/** Convex resource type, `credentials`: a short-lived key scoped to one lane deployment. */
export const mintKey = internalAction({
  args: {
    laneId: v.id("lanes"),
    deploymentName: v.string(),
    holder: v.string(),
    purpose: v.union(v.literal("deployer"), v.literal("agent")),
  },
  returns: v.object({ key: v.string(), expiresAt: v.number(), name: v.string() }),
  handler: async (ctx, args) => {
    const ttlMs = args.purpose === "deployer" ? 31 * 60_000 : 4 * 60 * 60_000;
    const name = `${args.purpose}-${slug(args.holder)}-${Date.now().toString(36)}`;
    const key = await createDeployKey(
      args.deploymentName,
      name,
      args.purpose === "deployer" ? DEPLOYER_ACTIONS : AGENT_ACTIONS,
      ttlMs,
    );
    const expiresAt = Date.now() + ttlMs;
    await ctx.runMutation(internal.lanes.recordKey, {
      laneId: args.laneId,
      name,
      holder: args.holder,
      purpose: args.purpose,
      expiresAt,
    });
    return { key, expiresAt, name };
  },
});

export const revokeKeys = internalAction({
  args: { laneId: v.id("lanes") },
  returns: v.null(),
  handler: async (ctx, { laneId }) => {
    const { deploymentName, keys } = await ctx.runQuery(internal.lanes.keysToRevoke, { laneId });
    if (!deploymentName) return null;
    const done = [];
    for (const k of keys) {
      try {
        await deleteDeployKey(deploymentName, k.name);
      } catch {
        // Already expired or deleted; either way it no longer works.
      }
      done.push(k.id);
    }
    await ctx.runMutation(internal.lanes.markKeysRevoked, { ids: done });
    return null;
  },
});

/** Convex resource type, `teardown`: delete the deployment once the grace period ends. */
export const teardown = internalAction({
  args: { laneId: v.id("lanes") },
  returns: v.null(),
  handler: async (ctx, { laneId }) => {
    const info = await ctx.runQuery(internal.lanes.getForProvision, { laneId });
    // Reopened during the grace period, or already gone.
    if (!info || info.lane.state !== "archived" || !info.lane.deploymentName) return null;
    const started = Date.now();
    await deleteDeployment(info.lane.deploymentName);
    await ctx.runMutation(internal.lanes.markDeleted, { laneId, tookMs: Date.now() - started });
    return null;
  },
});
