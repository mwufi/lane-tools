import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  AGENT_ACTIONS,
  DEPLOYER_ACTIONS,
  SEED_ACTIONS,
  createDeployKey,
  createDeployment,
  deleteDeployKey,
  setDeploymentReference,
  deleteDeployment,
  setDeploymentEnv,
  inspectTeamToken,
  siteUrlFor,
} from "./lib/mgmt";

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
}

/** "preview/<branch>": letters, digits, dashes and slashes, at most 100 characters. */
export function previewReference(branch: string): string {
  const ref = branch.toLowerCase().replace(/[^a-z0-9/-]+/g, "-").replace(/-+/g, "-")
    .replace(/\/+/g, "/").replace(/^[-/]+|[-/]+$/g, "").slice(0, 92).replace(/[-/]+$/, "");
  return `preview/${ref || "lane"}`;
}

/** Per-lane values that the repo's allowlist still permits. */
export function allowedLaneEnv(
  vars: Record<string, string>,
  allow: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    const pattern = allow[name];
    if (pattern !== undefined && new RegExp(`^(?:${pattern})$`).test(value)) out[name] = value;
  }
  return out;
}

// Each repo creates lanes with the token of the Convex team it's connected to (Settings, Convex).
// Repos registered before connections existed fall back to CONVEX_TEAM_TOKEN.
async function repoToken(ctx: ActionCtx, repo: string): Promise<string | undefined> {
  return (await ctx.runQuery(internal.adminPanel.tokenForRepo, { repo })) ?? undefined;
}

/** Convex resource type, `ensure`: create a preview deployment and set the lane env. */
export const provision = internalAction({
  args: { laneId: v.id("lanes") },
  returns: v.null(),
  handler: async (ctx, { laneId }) => {
    const started = Date.now();
    const data = await ctx.runQuery(internal.lanes.getForProvision, { laneId });
    if (!data || !data.repoCfg || data.lane.state !== "provisioning") return null;
    const { lane, repoCfg } = data;
    try {
      const token = await repoToken(ctx, lane.repo);
      // Name it the way Convex names a branch's preview ("preview/<branch>"). If that is
      // taken (a native preview for the branch, or a lane still in its grace period),
      // add a suffix rather than adopt a deployment the lane doesn't own.
      const reference = previewReference(lane.branch);
      const dep = await createDeployment(repoCfg.convexProjectId, reference, token).catch((e) => {
        if (!/-> 4\d\d/.test(String(e))) throw e;
        return createDeployment(repoCfg.convexProjectId, `${reference.slice(0, 90)}-${Date.now().toString(36)}`, token);
      });
      const env = {
        ...repoCfg.env,
        ...allowedLaneEnv(lane.env ?? {}, repoCfg.laneEnvAllow ?? {}),
        LANE_REPO: lane.repo,
        LANE_BRANCH: lane.branch,
      };
      // A 31-minute key used once for env setup, then deleted.
      const setupKeyName = `lane-setup-${Date.now().toString(36)}`;
      const setupKey = await createDeployKey(
        dep.name,
        setupKeyName,
        ["deployment:env:write", "deployment:env:view"],
        0,
        token,
      );
      await setDeploymentEnv(dep.deploymentUrl, setupKey, env);
      await deleteDeployKey(dep.name, setupKeyName, token);
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

/** Set allow-listed env vars on a ready lane's deployment with a one-use env-write key. */
export const setLaneEnv = internalAction({
  args: {
    deploymentName: v.string(),
    deploymentUrl: v.string(),
    vars: v.record(v.string(), v.union(v.string(), v.null())), // null removes
    repo: v.string(), // whose Convex team token to use
  },
  returns: v.null(),
  handler: async (ctx, { deploymentName, deploymentUrl, vars, repo }) => {
    const teamToken = await repoToken(ctx, repo);
    const keyName = `lane-env-${Date.now().toString(36)}`;
    const key = await createDeployKey(deploymentName, keyName, ["deployment:env:write", "deployment:env:view"], 0, teamToken);
    try {
      await setDeploymentEnv(deploymentUrl, key, vars);
    } finally {
      await deleteDeployKey(deploymentName, keyName, teamToken).catch(() => {});
    }
    return null;
  },
});

/** A claimed warm-pool spare takes its branch's name in the Convex dashboard ("preview/<branch>"). */
export const renameForBranch = internalAction({
  args: { deploymentName: v.string(), branch: v.string(), repo: v.string() },
  returns: v.null(),
  handler: async (ctx, { deploymentName, branch, repo }) => {
    const token = await repoToken(ctx, repo);
    const reference = previewReference(branch);
    // Taken (Convex's own preview for the branch, or a lane in its grace period): add a suffix.
    await setDeploymentReference(deploymentName, reference, token).catch((e) => {
      if (!/-> 4\d\d/.test(String(e))) throw e;
      return setDeploymentReference(deploymentName, `${reference.slice(0, 90)}-${Date.now().toString(36)}`, token);
    });
    return null;
  },
});

/** Convex resource type, `credentials`: a short-lived key scoped to one lane deployment. */
export const mintKey = internalAction({
  args: {
    laneId: v.id("lanes"),
    deploymentName: v.string(),
    holder: v.string(),
    purpose: v.union(v.literal("deployer"), v.literal("agent"), v.literal("seed")),
  },
  returns: v.object({ key: v.string(), expiresAt: v.number(), name: v.string() }),
  handler: async (ctx, args) => {
    const info = await ctx.runQuery(internal.lanes.getForProvision, { laneId: args.laneId });
    const token = info ? await repoToken(ctx, info.lane.repo) : undefined;
    const ttlMs = args.purpose === "agent" ? 4 * 60 * 60_000 : 31 * 60_000;
    const name = `${args.purpose}-${slug(args.holder)}-${Date.now().toString(36)}`;
    const key = await createDeployKey(
      args.deploymentName,
      name,
      args.purpose === "deployer" ? DEPLOYER_ACTIONS : args.purpose === "seed" ? SEED_ACTIONS : AGENT_ACTIONS,
      ttlMs,
      token,
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
    const info = await ctx.runQuery(internal.lanes.getForProvision, { laneId });
    const token = info ? await repoToken(ctx, info.lane.repo) : undefined;
    const done = [];
    for (const k of keys) {
      try {
        await deleteDeployKey(deploymentName, k.name, token);
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
    await deleteDeployment(info.lane.deploymentName, await repoToken(ctx, info.lane.repo));
    await ctx.runMutation(internal.lanes.markDeleted, { laneId, tookMs: Date.now() - started });
    return null;
  },
});

/** Check a pasted team token: which team it belongs to and that team's projects. */
export const inspectToken = internalAction({
  args: { token: v.string() },
  returns: v.object({ teamId: v.number(), projects: v.array(v.object({ id: v.number(), name: v.string(), slug: v.string() })) }),
  handler: async (_ctx, { token }) => {
    const r = await inspectTeamToken(token);
    return { teamId: r.teamId, projects: r.projects.map((p) => ({ id: p.id, name: p.name, slug: p.slug })) };
  },
});

/** Projects in a connected Convex team (or the legacy CONVEX_TEAM_TOKEN's team), for the repo form. */
export const projects = internalAction({
  args: { teamId: v.optional(v.id("convexTeams")) },
  returns: v.array(v.object({ id: v.number(), name: v.string(), slug: v.string() })),
  handler: async (ctx, { teamId }) => {
    const token = teamId ? await ctx.runQuery(internal.adminPanel.convexTeamToken, { id: teamId }) : undefined;
    if (teamId && !token) throw new Error("That Convex team isn't connected");
    const r = await inspectTeamToken(token ?? undefined);
    return r.projects.map((p) => ({ id: p.id, name: p.name, slug: p.slug }));
  },
});
