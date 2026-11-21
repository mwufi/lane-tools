import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const laneState = v.union(
  v.literal("provisioning"),
  v.literal("ready"),
  v.literal("failed"),
  v.literal("archived"),
  v.literal("deleted"),
);

export const agentStatus = v.union(
  v.literal("working"),
  v.literal("waiting"),
  v.literal("done"),
);

export default defineSchema({
  // One row per repository that lanes are allowed for. Registered by an admin.
  repos: defineTable({
    repo: v.string(), // "owner/name"
    convexProjectId: v.number(), // project that lane deployments are created in
    seedFunction: v.optional(v.string()), // e.g. "seed:run", run once per lane after first deploy
    setupFunctions: v.optional(v.array(v.string())), // run in order once per lane (migrations, then seed); overrides seedFunction
    deployArgs: v.optional(v.array(v.string())), // extra `convex deploy` args, e.g. ["--typecheck", "disable"]
    env: v.record(v.string(), v.string()), // env vars set on every lane deployment
    graceMs: v.number(), // delay between archive and deployment delete
  }).index("by_repo", ["repo"]),

  // Agent/person tokens. Only the SHA-256 hash is stored.
  tokens: defineTable({
    hash: v.string(),
    person: v.string(),
    revoked: v.boolean(),
  }).index("by_hash", ["hash"]),

  lanes: defineTable({
    repo: v.string(),
    branch: v.string(),
    state: laneState,
    deploymentName: v.optional(v.string()),
    deploymentUrl: v.optional(v.string()),
    siteUrl: v.optional(v.string()),
    headSha: v.optional(v.string()), // what's pushed to the branch
    headConvexChanged: v.optional(v.boolean()),
    deployedSha: v.optional(v.string()), // what the backend is running
    seeded: v.boolean(),
    error: v.optional(v.string()),
    createdBy: v.string(),
    createdAt: v.number(),
    readyAt: v.optional(v.number()),
    lastActivity: v.number(),
    // Serialized deployer: a lease, so a crashed deployer can't hold it forever.
    lock: v.optional(
      v.object({ holder: v.string(), sha: v.string(), expiresAt: v.number() }),
    ),
  })
    .index("by_repo_and_branch", ["repo", "branch"])
    .index("by_state", ["state"]),

  // High-churn heartbeat rows live apart from the lane row.
  laneAgents: defineTable({
    laneId: v.id("lanes"),
    vendor: v.string(), // claude | codex | cursor | amp | human | other
    person: v.string(),
    task: v.string(),
    machine: v.string(), // cloud | orb | laptop | ci
    threadUrl: v.optional(v.string()),
    status: agentStatus,
    joinedAt: v.number(),
    lastSeen: v.number(),
    lastSha: v.optional(v.string()),
  }).index("by_laneId", ["laneId"]),

  laneEvents: defineTable({
    laneId: v.id("lanes"),
    type: v.string(),
    actor: v.string(),
    detail: v.string(),
    at: v.number(),
  }).index("by_laneId", ["laneId"]),

  // Every key minted for a lane, so teardown can revoke them and the page can audit them.
  laneKeys: defineTable({
    laneId: v.id("lanes"),
    name: v.string(),
    holder: v.string(),
    purpose: v.string(),
    expiresAt: v.number(),
    revoked: v.boolean(),
  }).index("by_laneId", ["laneId"]),
});
