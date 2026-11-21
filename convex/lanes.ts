import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { agentStatus } from "./schema";

const DEPLOY_LEASE_MS = 5 * 60_000;
export const IDLE_AFTER_MS = 15 * 60_000;
const DORMANT_AFTER_MS = 14 * 24 * 60 * 60_000;

async function laneFor(ctx: QueryCtx, repo: string, branch: string) {
  return await ctx.db
    .query("lanes")
    .withIndex("by_repo_and_branch", (q) => q.eq("repo", repo).eq("branch", branch))
    .unique();
}

async function logEvent(
  ctx: MutationCtx,
  laneId: Id<"lanes">,
  type: string,
  actor: string,
  detail: string,
) {
  await ctx.db.insert("laneEvents", { laneId, type, actor, detail, at: Date.now() });
}

// ---------------------------------------------------------------- lifecycle

/** Idempotent: the first caller provisions, every later caller gets the same lane. */
export const ensure = internalMutation({
  args: {
    repo: v.string(),
    branch: v.string(),
    actor: v.string(),
    headSha: v.optional(v.string()),
  },
  returns: v.object({ laneId: v.id("lanes"), created: v.boolean() }),
  handler: async (ctx, args) => {
    const repoCfg = await ctx.db
      .query("repos")
      .withIndex("by_repo", (q) => q.eq("repo", args.repo))
      .unique();
    if (!repoCfg) throw new Error(`repo ${args.repo} is not registered for lanes`);
    const now = Date.now();
    const existing = await laneFor(ctx, args.repo, args.branch);
    if (existing) {
      const patch: Partial<Doc<"lanes">> = { lastActivity: now };
      if (args.headSha && !existing.headSha) patch.headSha = args.headSha;
      if (existing.state === "archived" && existing.deploymentName) {
        // Reopened inside the grace period: keep the deployment, no cold start.
        patch.state = "ready";
        await logEvent(ctx, existing._id, "revived", args.actor, "reopened during grace period");
      } else if (existing.state === "deleted" || existing.state === "failed") {
        Object.assign(patch, {
          state: "provisioning",
          error: undefined,
          deploymentName: undefined,
          deploymentUrl: undefined,
          siteUrl: undefined,
          deployedSha: undefined,
          seeded: false,
          readyAt: undefined,
          lock: undefined,
          headSha: args.headSha,
          headConvexChanged: undefined,
        });
        // A fresh lane: agents from the old one are history, not current work.
        for (const a of await ctx.db
          .query("laneAgents")
          .withIndex("by_laneId", (q) => q.eq("laneId", existing._id))
          .take(500)) {
          await ctx.db.delete("laneAgents", a._id);
        }
        patch.createdAt = now;
        patch.createdBy = args.actor;
        await logEvent(ctx, existing._id, "provisioning", args.actor, "re-provisioning");
        await ctx.scheduler.runAfter(0, internal.provision.provision, { laneId: existing._id });
      }
      await ctx.db.patch("lanes", existing._id, patch);
      return { laneId: existing._id, created: false };
    }
    const laneId = await ctx.db.insert("lanes", {
      repo: args.repo,
      branch: args.branch,
      state: "provisioning",
      headSha: args.headSha,
      seeded: false,
      createdBy: args.actor,
      createdAt: now,
      lastActivity: now,
    });
    await logEvent(ctx, laneId, "provisioning", args.actor, "lane requested");
    await ctx.scheduler.runAfter(0, internal.provision.provision, { laneId });
    return { laneId, created: true };
  },
});

export const getForProvision = internalQuery({
  args: { laneId: v.id("lanes") },
  handler: async (ctx, { laneId }) => {
    const lane = await ctx.db.get("lanes", laneId);
    if (!lane) return null;
    const repoCfg = await ctx.db
      .query("repos")
      .withIndex("by_repo", (q) => q.eq("repo", lane.repo))
      .unique();
    return { lane, repoCfg };
  },
});

export const markProvisioned = internalMutation({
  args: {
    laneId: v.id("lanes"),
    deploymentName: v.string(),
    deploymentUrl: v.string(),
    siteUrl: v.string(),
    tookMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lane = await ctx.db.get("lanes", args.laneId);
    if (!lane || lane.state !== "provisioning") return null;
    await ctx.db.patch("lanes", args.laneId, {
      state: "ready",
      deploymentName: args.deploymentName,
      deploymentUrl: args.deploymentUrl,
      siteUrl: args.siteUrl,
      readyAt: Date.now(),
    });
    await logEvent(
      ctx,
      args.laneId,
      "ready",
      "control-plane",
      `deployment ${args.deploymentName} ready in ${(args.tookMs / 1000).toFixed(1)}s`,
    );
    return null;
  },
});

export const markFailed = internalMutation({
  args: { laneId: v.id("lanes"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { laneId, error }) => {
    await ctx.db.patch("lanes", laneId, { state: "failed", error });
    await logEvent(ctx, laneId, "failed", "control-plane", error);
    return null;
  },
});

/** PR merged/closed, branch deleted, or `lane down`. Keys revoked now, deployment after grace. */
export const archive = internalMutation({
  args: { repo: v.string(), branch: v.string(), actor: v.string(), reason: v.string() },
  returns: v.union(v.null(), v.object({ graceMs: v.number() })),
  handler: async (ctx, args) => {
    const lane = await laneFor(ctx, args.repo, args.branch);
    if (!lane || lane.state === "archived" || lane.state === "deleted") return null;
    const repoCfg = await ctx.db
      .query("repos")
      .withIndex("by_repo", (q) => q.eq("repo", args.repo))
      .unique();
    const graceMs = repoCfg?.graceMs ?? 0;
    await ctx.db.patch("lanes", lane._id, { state: "archived", lock: undefined });
    for await (const agent of ctx.db
      .query("laneAgents")
      .withIndex("by_laneId", (q) => q.eq("laneId", lane._id))) {
      if (agent.status !== "done") await ctx.db.patch("laneAgents", agent._id, { status: "done" });
    }
    await logEvent(
      ctx,
      lane._id,
      "archived",
      args.actor,
      `${args.reason}; deployment deleted in ${Math.round(graceMs / 1000)}s`,
    );
    await ctx.scheduler.runAfter(0, internal.provision.revokeKeys, { laneId: lane._id });
    await ctx.scheduler.runAfter(graceMs, internal.provision.teardown, { laneId: lane._id });
    return { graceMs };
  },
});

export const keysToRevoke = internalQuery({
  args: { laneId: v.id("lanes") },
  handler: async (ctx, { laneId }) => {
    const lane = await ctx.db.get("lanes", laneId);
    const keys = await ctx.db
      .query("laneKeys")
      .withIndex("by_laneId", (q) => q.eq("laneId", laneId))
      .take(500);
    return {
      deploymentName: lane?.deploymentName ?? null,
      keys: keys.filter((k) => !k.revoked).map((k) => ({ id: k._id, name: k.name })),
    };
  },
});

export const markKeysRevoked = internalMutation({
  args: { ids: v.array(v.id("laneKeys")) },
  returns: v.null(),
  handler: async (ctx, { ids }) => {
    for (const id of ids) await ctx.db.patch("laneKeys", id, { revoked: true });
    return null;
  },
});

export const markDeleted = internalMutation({
  args: { laneId: v.id("lanes"), tookMs: v.number() },
  returns: v.null(),
  handler: async (ctx, { laneId, tookMs }) => {
    await ctx.db.patch("lanes", laneId, {
      state: "deleted",
      deploymentName: undefined,
      deploymentUrl: undefined,
      siteUrl: undefined,
      deployedSha: undefined,
      seeded: false,
    });
    await logEvent(ctx, laneId, "deleted", "control-plane", `deployment deleted in ${(tookMs / 1000).toFixed(1)}s`);
    return null;
  },
});

export const sweepDormant = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - DORMANT_AFTER_MS;
    const ready = await ctx.db
      .query("lanes")
      .withIndex("by_state", (q) => q.eq("state", "ready"))
      .take(500);
    for (const lane of ready) {
      if (lane.lastActivity < cutoff) {
        await ctx.runMutation(internal.lanes.archive, {
          repo: lane.repo,
          branch: lane.branch,
          actor: "control-plane",
          reason: "dormant for 14 days",
        });
      }
    }
    return null;
  },
});

// ---------------------------------------------------------------- pushes & deploys

/** A push landed on the branch. The lane follows it. */
export const push = internalMutation({
  args: {
    repo: v.string(),
    branch: v.string(),
    sha: v.string(),
    convexChanged: v.boolean(),
    actor: v.string(),
  },
  returns: v.object({ lane: v.boolean(), deployNeeded: v.boolean() }),
  handler: async (ctx, args) => {
    const lane = await laneFor(ctx, args.repo, args.branch);
    // Lanes start on PR open or `lane up`, never on a bare push.
    if (!lane || lane.state === "deleted" || lane.state === "archived") {
      return { lane: false, deployNeeded: false };
    }
    const now = Date.now();
    const lockHeld = lane.lock !== undefined && lane.lock.expiresAt > now;
    const backendCurrent = lane.deployedSha !== undefined && lane.deployedSha === lane.headSha;
    if (!args.convexChanged && backendCurrent && !lockHeld) {
      // Nothing under convex/ changed: the running backend already matches this commit.
      await ctx.db.patch("lanes", lane._id, {
        headSha: args.sha,
        headConvexChanged: false,
        deployedSha: args.sha,
        lastActivity: now,
      });
      await logEvent(ctx, lane._id, "push", args.actor, `${args.sha.slice(0, 7)} (convex/ unchanged, no deploy)`);
      return { lane: true, deployNeeded: false };
    }
    await ctx.db.patch("lanes", lane._id, {
      headSha: args.sha,
      headConvexChanged: args.convexChanged,
      lastActivity: now,
    });
    await logEvent(
      ctx,
      lane._id,
      "push",
      args.actor,
      `${args.sha.slice(0, 7)}${args.convexChanged ? " (convex/ changed)" : ""}`,
    );
    return { lane: true, deployNeeded: lane.state === "ready" };
  },
});

export const claimDeploy = internalMutation({
  args: { repo: v.string(), branch: v.string(), holder: v.string(), force: v.boolean() },
  returns: v.union(
    v.object({ status: v.literal("claimed"), laneId: v.id("lanes"), sha: v.string(), needSeed: v.boolean(), deploymentName: v.string() }),
    v.object({ status: v.literal("busy"), holder: v.string(), sha: v.string() }),
    v.object({ status: v.literal("uptodate"), sha: v.string() }),
    v.object({ status: v.literal("nothing") }),
    v.object({ status: v.literal("notready"), state: v.string() }),
  ),
  handler: async (ctx, args) => {
    const lane = await laneFor(ctx, args.repo, args.branch);
    if (!lane) return { status: "notready" as const, state: "missing" };
    if (lane.state !== "ready" || !lane.deploymentName) {
      return { status: "notready" as const, state: lane.state };
    }
    const now = Date.now();
    if (lane.lock && lane.lock.expiresAt > now && lane.lock.holder !== args.holder) {
      return { status: "busy" as const, holder: lane.lock.holder, sha: lane.lock.sha };
    }
    if (!lane.headSha) return { status: "nothing" as const };
    if (!args.force && lane.deployedSha === lane.headSha) {
      return { status: "uptodate" as const, sha: lane.headSha };
    }
    await ctx.db.patch("lanes", lane._id, {
      lock: { holder: args.holder, sha: lane.headSha, expiresAt: now + DEPLOY_LEASE_MS },
    });
    await logEvent(ctx, lane._id, "deploy_start", args.holder, lane.headSha.slice(0, 7));
    return {
      status: "claimed" as const,
      laneId: lane._id,
      sha: lane.headSha,
      needSeed: !lane.seeded,
      deploymentName: lane.deploymentName,
    };
  },
});

export const finishDeploy = internalMutation({
  args: {
    repo: v.string(),
    branch: v.string(),
    holder: v.string(),
    sha: v.string(),
    ok: v.boolean(),
    seeded: v.boolean(),
    detail: v.string(),
  },
  returns: v.object({ again: v.boolean() }),
  handler: async (ctx, args) => {
    const lane = await laneFor(ctx, args.repo, args.branch);
    if (!lane) return { again: false };
    if (lane.lock && lane.lock.holder !== args.holder) {
      // Our lease expired and someone else took over; don't clobber their state.
      return { again: false };
    }
    const patch: Partial<Doc<"lanes">> = { lock: undefined, lastActivity: Date.now() };
    if (args.ok) {
      patch.deployedSha = args.sha;
      if (args.seeded) patch.seeded = true;
      patch.error = undefined;
    } else {
      patch.error = args.detail.slice(0, 2000);
    }
    await ctx.db.patch("lanes", lane._id, patch);
    await logEvent(
      ctx,
      lane._id,
      args.ok ? "deploy_ok" : "deploy_failed",
      args.holder,
      `${args.sha.slice(0, 7)} ${args.detail}`.slice(0, 2000),
    );
    // Pushes that landed mid-deploy collapse into one follow-up deploy of the newest HEAD.
    return { again: args.ok && lane.state === "ready" && lane.headSha !== args.sha };
  },
});

export const recordKey = internalMutation({
  args: {
    laneId: v.id("lanes"),
    name: v.string(),
    holder: v.string(),
    purpose: v.string(),
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("laneKeys", { ...args, revoked: false });
    await logEvent(ctx, args.laneId, "key_minted", args.holder, `${args.purpose} key ${args.name}`);
    return null;
  },
});

export const logLaneEvent = internalMutation({
  args: { repo: v.string(), branch: v.string(), type: v.string(), actor: v.string(), detail: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lane = await laneFor(ctx, args.repo, args.branch);
    if (lane) await logEvent(ctx, lane._id, args.type, args.actor, args.detail);
    return null;
  },
});

// ---------------------------------------------------------------- agents

const ADJECTIVES = ["spicy", "sleepy", "brave", "fuzzy", "lucky", "quiet", "swift", "jolly", "salty", "sunny", "mighty", "witty", "zesty", "cosmic", "dapper", "nimble", "rusty", "silver", "bouncy", "curious", "gentle", "plucky", "snappy", "tidy", "wild", "crisp", "mellow", "bold", "frosty", "velvet"];
const ANIMALS = ["lobster", "otter", "falcon", "panda", "gecko", "heron", "badger", "koala", "lynx", "marmot", "narwhal", "octopus", "puffin", "quokka", "raven", "salmon", "tapir", "walrus", "yak", "zebra", "beaver", "coyote", "dingo", "ferret", "ibis", "jackal", "lemur", "moose", "newt", "orca"];

/** A short, memorable name that is unique among the agents on this lane. */
function agentName(taken: Set<string>): string {
  for (let i = 0; i < 50; i++) {
    const n = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)] + "-" + ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    if (!taken.has(n)) return n;
  }
  return "agent-" + Math.floor(Math.random() * 1e6).toString(36);
}

export const join = internalMutation({
  args: {
    repo: v.string(),
    branch: v.string(),
    vendor: v.string(),
    person: v.string(),
    task: v.string(),
    machine: v.string(),
    threadUrl: v.optional(v.string()),
    agentId: v.optional(v.id("laneAgents")),
  },
  returns: v.object({ agentId: v.id("laneAgents"), name: v.string() }),
  handler: async (ctx, args) => {
    const lane = await laneFor(ctx, args.repo, args.branch);
    if (!lane) throw new Error("no lane for this branch; run `lane up` first");
    const now = Date.now();
    if (args.agentId) {
      const prev = await ctx.db.get("laneAgents", args.agentId);
      if (prev && prev.laneId === lane._id) {
        await ctx.db.patch("laneAgents", prev._id, {
          task: args.task,
          status: "working",
          lastSeen: now,
          threadUrl: args.threadUrl ?? prev.threadUrl,
        });
        return { agentId: prev._id, name: prev.name ?? prev.vendor };
      }
    }
    const existing = await ctx.db
      .query("laneAgents")
      .withIndex("by_laneId", (q) => q.eq("laneId", lane._id))
      .take(500);
    const name = agentName(new Set(existing.map((a) => a.name ?? "")));
    const id = await ctx.db.insert("laneAgents", {
      laneId: lane._id,
      name,
      vendor: args.vendor,
      person: args.person,
      task: args.task,
      machine: args.machine,
      threadUrl: args.threadUrl,
      status: "working",
      joinedAt: now,
      lastSeen: now,
    });
    await ctx.db.patch("lanes", lane._id, { lastActivity: now });
    await logEvent(ctx, lane._id, "join", name, args.task);
    return { agentId: id, name };
  },
});

export const heartbeat = internalMutation({
  args: {
    agentId: v.id("laneAgents"),
    status: agentStatus,
    task: v.optional(v.string()),
    lastSha: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const agent = await ctx.db.get("laneAgents", args.agentId);
    if (!agent) throw new Error("unknown agent");
    const patch: Partial<Doc<"laneAgents">> = { status: args.status, lastSeen: Date.now() };
    if (args.task) patch.task = args.task;
    if (args.lastSha) patch.lastSha = args.lastSha;
    await ctx.db.patch("laneAgents", agent._id, patch);
    if (args.status === "done" && agent.status !== "done") {
      await logEvent(ctx, agent.laneId, "leave", agent.name ?? `${agent.vendor}/${agent.person}`, agent.task);
    }
    return null;
  },
});

// ---------------------------------------------------------------- reads

function laneSummary(lane: Doc<"lanes">) {
  return {
    repo: lane.repo,
    branch: lane.branch,
    state: lane.state,
    deploymentName: lane.deploymentName ?? null,
    deploymentUrl: lane.deploymentUrl ?? null,
    siteUrl: lane.siteUrl ?? null,
    dashboardUrl: lane.deploymentName ? `https://dashboard.convex.dev/d/${lane.deploymentName}` : null,
    headSha: lane.headSha ?? null,
    deployedSha: lane.deployedSha ?? null,
    deploying: lane.lock ? { holder: lane.lock.holder, sha: lane.lock.sha } : null,
    seeded: lane.seeded,
    error: lane.error ?? null,
    createdBy: lane.createdBy,
    createdAt: lane.createdAt,
    readyAt: lane.readyAt ?? null,
    lastActivity: lane.lastActivity,
  };
}

export const view = internalQuery({
  args: { repo: v.string(), branch: v.string(), now: v.number() },
  handler: async (ctx, { repo, branch, now }) => {
    const lane = await laneFor(ctx, repo, branch);
    if (!lane) return null;
    const agents = await ctx.db
      .query("laneAgents")
      .withIndex("by_laneId", (q) => q.eq("laneId", lane._id))
      .take(200);
    const events = await ctx.db
      .query("laneEvents")
      .withIndex("by_laneId", (q) => q.eq("laneId", lane._id))
      .order("desc")
      .take(200);
    // Only this incarnation of the lane; older ones are history from before a re-provision.
    const current = events.filter((e) => e.at >= lane.createdAt).slice(0, 150);
    return {
      lane: laneSummary(lane),
      agents: agents.map((a) => ({
        id: a._id,
        name: a.name ?? null,
        vendor: a.vendor,
        person: a.person,
        task: a.task,
        machine: a.machine,
        threadUrl: a.threadUrl ?? null,
        status: a.status !== "done" && now - a.lastSeen > IDLE_AFTER_MS ? "idle" : a.status,
        joinedAt: a.joinedAt,
        lastSeen: a.lastSeen,
        lastSha: a.lastSha ?? null,
      })),
      events: current.map((e) => ({ type: e.type, actor: e.actor, detail: e.detail, at: e.at })),
    };
  },
});

export const list = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    const lanes = await ctx.db.query("lanes").order("desc").take(200);
    const out = [];
    for (const lane of lanes) {
      const agents = await ctx.db
        .query("laneAgents")
        .withIndex("by_laneId", (q) => q.eq("laneId", lane._id))
        .take(200);
      const active = agents.filter((a) => a.status !== "done" && now - a.lastSeen <= IDLE_AFTER_MS);
      out.push({ ...laneSummary(lane), activeAgents: active.length, totalAgents: agents.length });
    }
    return out;
  },
});

export const laneIdFor = internalQuery({
  args: { repo: v.string(), branch: v.string() },
  handler: async (ctx, { repo, branch }) => {
    const lane = await laneFor(ctx, repo, branch);
    return lane ? { laneId: lane._id, state: lane.state, deploymentName: lane.deploymentName ?? null } : null;
  },
});
