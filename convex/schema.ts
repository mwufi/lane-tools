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
    // Per-lane env vars callers may set with POST /api/lane/env: name -> value regex
    // (full match), e.g. {"SITE_URL": "https://app-git-[a-z0-9-]+\\.vercel\\.app"}.
    laneEnvAllow: v.optional(v.record(v.string(), v.string())),
    convexTeamId: v.optional(v.id("convexTeams")), // whose token creates its lanes (unset: CONVEX_TEAM_TOKEN)
    // Warm pool: this many spare lanes are kept deployed from the default branch and seeded,
    // so a new lane claims one instead of starting cold. Unset or 0 turns the pool off.
    poolSize: v.optional(v.number()),
  }).index("by_repo", ["repo"]),

  // Agent/person tokens. Only the SHA-256 hash is stored.
  tokens: defineTable({
    hash: v.string(),
    person: v.string(),
    revoked: v.boolean(),
    createdBy: v.optional(v.string()), // who minted it (admin panel, GitHub sign-in, or CLI admin)
    revokedBy: v.optional(v.string()),
    revokedAt: v.optional(v.number()),
  }).index("by_hash", ["hash"]),

  // Recent GitHub webhook deliveries, so the admin panel can show whether GitHub is connected
  // and why a delivery was refused. Pruned to the newest 200.
  webhookDeliveries: defineTable({
    event: v.string(),
    repo: v.optional(v.string()),
    ok: v.boolean(),
    note: v.string(),
    at: v.number(),
  }),

  // Convex teams lanes can be created in. Each holds that team's access token (never sent to
  // browsers); repos point at one. Separate from claiming lane-control, and rotatable.
  convexTeams: defineTable({
    label: v.string(),
    teamId: v.number(),
    token: v.string(),
    addedBy: v.string(),
    at: v.number(),
  }),

  // One-time setup state: who claimed this install, and pending GitHub App creations
  // (the state value GitHub hands back on the redirect).
  setup: defineTable({ kind: v.string(), value: v.string(), by: v.string(), at: v.number() }).index("by_kind_and_value", [
    "kind",
    "value",
  ]),

  // Audit trail of GitHub sign-ins (who, CLI or web, when).
  logins: defineTable({ person: v.string(), via: v.string(), at: v.number() }),

  lanes: defineTable({
    repo: v.string(),
    branch: v.string(),
    state: laneState,
    deploymentName: v.optional(v.string()),
    deploymentUrl: v.optional(v.string()),
    siteUrl: v.optional(v.string()),
    env: v.optional(v.record(v.string(), v.string())), // per-lane env set via /api/lane/env; reapplied on re-provision
    headSha: v.optional(v.string()), // what's pushed to the branch
    headConvexChanged: v.optional(v.boolean()),
    deployedSha: v.optional(v.string()), // what the backend is running
    seeded: v.boolean(),
    error: v.optional(v.string()),
    createdBy: v.string(),
    createdAt: v.number(),
    readyAt: v.optional(v.number()),
    lastActivity: v.number(),
    // A warm-pool spare: `branch` is "pool:<id>" (a colon can't appear in a git branch) until
    // a real branch claims it, which clears this flag.
    pool: v.optional(v.boolean()),
    // Serialized deployer: a lease, so a crashed deployer can't hold it forever.
    lock: v.optional(
      v.object({ holder: v.string(), sha: v.string(), expiresAt: v.number() }),
    ),
  })
    .index("by_repo_and_branch", ["repo", "branch"])
    .index("by_state", ["state"])
    .index("by_repo_and_pool", ["repo", "pool"]),

  // High-churn heartbeat rows live apart from the lane row.
  laneAgents: defineTable({
    laneId: v.id("lanes"),
    name: v.optional(v.string()), // unique per lane, e.g. "spicy-lobster"
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

  // Seed snapshots: a ZIP export of a freshly seeded lane (`lane pool fill` makes them). A new
  // lane imports the newest one instead of running every setup function. `tree` is the git tree
  // of convex/ it was seeded from, so the filler knows when to make a fresh one.
  seedSnapshots: defineTable({
    repo: v.string(),
    sha: v.string(),
    tree: v.optional(v.string()),
    storageId: v.id("_storage"),
    bytes: v.number(),
    createdBy: v.string(),
    at: v.number(),
  }).index("by_repo", ["repo"]),

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
