// Data behind the admin panel (/admin). Every function here is internal; the
// HTTP routes in http.ts check that the caller is a lane admin first.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

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
        convexTeamId: r.convexTeamId ?? null,
        graceMs: r.graceMs,
        poolSize: r.poolSize ?? 0,
        warmSpares: lanes.filter((l) => l.pool && l.state === "ready" && l.seeded).length,
        openLanes: lanes.filter((l) => !l.pool && l.state !== "deleted" && l.state !== "archived").length,
      });
    }
    return out.sort((a, b) => a.repo.localeCompare(b.repo));
  },
});

export const addRepo = internalMutation({
  args: { repo: v.string(), convexProjectId: v.number(), convexTeamId: v.optional(v.id("convexTeams")) },
  returns: v.null(),
  handler: async (ctx, { repo, convexProjectId, convexTeamId }) => {
    if (convexTeamId && !(await ctx.db.get("convexTeams", convexTeamId))) throw new Error("That Convex team isn't connected");
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
      convexTeamId,
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
    convexTeamId: v.optional(v.union(v.id("convexTeams"), v.null())), // null: back to the default
    poolSize: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { repo, convexTeamId, ...patch }) => {
    if (convexTeamId && !(await ctx.db.get("convexTeams", convexTeamId))) throw new Error("That Convex team isn't connected");
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
    if (patch.poolSize !== undefined && !(Number.isInteger(patch.poolSize) && patch.poolSize >= 0 && patch.poolSize <= 10)) {
      throw new Error("pool size must be a whole number from 0 to 10");
    }
    if (patch.setupFunctions?.some((f) => !/^[\w/.-]+:[\w]+$/.test(f))) throw new Error("setup functions look like module:function");
    if (patch.laneEnvAllow) for (const [n, p] of Object.entries(patch.laneEnvAllow)) checkPattern(n, p);
    const clean = Object.fromEntries(Object.entries(patch).filter(([, x]) => x !== undefined));
    if (clean.setupFunctions) await ctx.db.patch("repos", r._id, { seedFunction: undefined });
    await ctx.db.patch("repos", r._id, clean);
    if (convexTeamId !== undefined) await ctx.db.patch("repos", r._id, { convexTeamId: convexTeamId ?? undefined });
    if (patch.poolSize !== undefined) await ctx.scheduler.runAfter(0, internal.pool.refill, { repo });
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

/**
 * Facts behind the Get started checklist, read from the control plane's own tables so
 * every step checks itself: nothing is ticked by hand.
 */
export const onboarding = internalQuery({
  args: {},
  handler: async (ctx) => {
    const repos = await ctx.db.query("repos").take(200);
    const tokens = await ctx.db.query("tokens").take(500);
    const lanes = await ctx.db.query("lanes").order("desc").take(500);
    const agents = await ctx.db.query("laneAgents").order("desc").take(1);
    const events = await ctx.db.query("laneEvents").order("desc").take(3000);
    const logins = await ctx.db.query("logins").order("desc").take(1);

    // Tokens made for machines (CI, Vercel, agent envs): minted from the admin panel or CLI
    // for a non-person name. Tokens from a GitHub sign-in, and the CLI bootstrap token
    // (no createdBy), belong to people.
    const machineTokens = tokens.filter(
      (t) => !t.revoked && t.createdBy !== undefined && !t.createdBy.startsWith("github:") && t.person !== t.createdBy.replace(/^admin:/, ""),
    );
    const machineNames = new Set(["github", "github-actions", ...machineTokens.map((t) => t.person)]);
    const isMachine = (actor: string) => machineNames.has(actor) || actor.startsWith("github/");
    // A push, or a lane the GitHub Action created or deployed (holders look like "github-actions#123").
    const pushes = events.filter(
      (e) => e.type === "push" || ((e.type === "provisioning" || e.type === "deploy_start") && isMachine(e.actor.split("#")[0])),
    );
    const githubPush = pushes.find((e) => isMachine(e.actor));
    const deliveries = await ctx.db.query("webhookDeliveries").order("desc").take(200);
    const goodDelivery = deliveries.find((d) => d.ok);
    const lastDelivery = deliveries[0];
    const live = lanes.filter((l) => l.deployedSha);
    const failed = lanes.find((l) => l.state === "failed");
    const archived = events.find((e) => e.type === "archived");
    const envSet = events.find((e) => e.type === "env");
    const laneById = new Map(lanes.map((l) => [l._id, l]));
    const where = (laneId: string | undefined) => {
      const l = laneId ? laneById.get(laneId as never) : undefined;
      return l ? `${l.repo} · ${l.branch}` : null;
    };
    const laneIds = (repo: string) => new Set(lanes.filter((l) => l.repo === repo).map((l) => l._id as string));
    return {
      repos: repos.map((r) => {
        const mine = lanes.filter((l) => l.repo === r.repo && !l.pool);
        const ids = laneIds(r.repo);
        const pushOf = pushes.find((e) => ids.has(e.laneId) && isMachine(e.actor));
        const hook = deliveries.find((d) => d.repo === r.repo);
        const liveLane = mine.find((l) => l.deployedSha && l.state !== "archived" && l.state !== "deleted");
        const failedLane = mine.find((l) => l.state === "failed");
        return {
          repo: r.repo,
          convexProjectId: r.convexProjectId,
          setup: (r.setupFunctions ?? (r.seedFunction ? [r.seedFunction] : [])).length,
          laneEnvAllow: Object.keys(r.laneEnvAllow ?? {}).length,
          lanes: mine.filter((l) => l.state !== "deleted" && l.state !== "archived").length,
          live: liveLane ? { branch: liveLane.branch, url: liveLane.deploymentUrl ?? null } : null,
          everLive: mine.some((l) => l.deployedSha),
          failed: failedLane ? { branch: failedLane.branch, error: (failedLane.error ?? "").slice(0, 300) } : null,
          archived: mine.some((l) => l.state === "archived" || l.state === "deleted"),
          machinePush: pushOf ? { actor: pushOf.actor, at: pushOf.at } : null,
          lastDelivery: hook ? { event: hook.event, ok: hook.ok, note: hook.note, at: hook.at } : null,
        };
      }),
      webhook: {
        secretSet: !!(process.env.GITHUB_WEBHOOK_SECRET || process.env.GITHUB_APP_WEBHOOK_SECRET),
        connected: goodDelivery ? { event: goodDelivery.event, at: goodDelivery.at, repo: goodDelivery.repo ?? null } : null,
        last: lastDelivery ? { event: lastDelivery.event, ok: lastDelivery.ok, note: lastDelivery.note, at: lastDelivery.at } : null,
      },
      machineTokens: machineTokens.map((t) => t.person),
      firstSignIn: logins[0] ? logins[0].person : null,
      githubPush: githubPush ? { actor: githubPush.actor, at: githubPush.at, where: where(githubPush.laneId) } : null,
      anyPush: pushes.length > 0,
      firstLive: live.length ? { where: `${live[live.length - 1].repo} · ${live[live.length - 1].branch}`, count: live.length } : null,
      provisionedOnce: lanes.some((l) => l.readyAt !== undefined),
      failed: failed ? { where: `${failed.repo} · ${failed.branch}`, error: (failed.error ?? "").slice(0, 300) } : null,
      agentJoined: agents.length > 0 ? { vendor: agents[0].vendor, at: agents[0].joinedAt } : null,
      archived: archived ? { where: where(archived.laneId), at: archived.at, detail: archived.detail } : null,
      envSet: envSet ? { where: where(envSet.laneId) } : null,
    };
  },
});

/** Record one GitHub webhook delivery; keeps the newest 200. */
export const logDelivery = internalMutation({
  args: { event: v.string(), repo: v.optional(v.string()), ok: v.boolean(), note: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("webhookDeliveries", { ...args, note: args.note.slice(0, 500), at: Date.now() });
    const old = await ctx.db.query("webhookDeliveries").order("desc").take(260);
    for (const d of old.slice(200)) await ctx.db.delete("webhookDeliveries", d._id);
    return null;
  },
});

/** Recent webhook deliveries, newest first. */
export const deliveries = internalQuery({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("webhookDeliveries").order("desc").take(50)).map((d) => ({
      event: d.event,
      repo: d.repo ?? null,
      ok: d.ok,
      note: d.note,
      at: d.at,
    })),
});

/** Reserve the claim of an install with no admins; false if someone claimed it moments ago. */
export const reserveClaim = internalMutation({
  args: { login: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { login }) => {
    // Guards against two people claiming at once. The HTTP route only gets here while the
    // install has no admins, so an old claim (admins since removed) doesn't block a new one.
    const prior = await ctx.db.query("setup").withIndex("by_kind_and_value", (q) => q.eq("kind", "claim")).order("desc").first();
    if (prior && Date.now() - prior.at < 5 * 60_000) return false;
    await ctx.db.insert("setup", { kind: "claim", value: login, by: login, at: Date.now() });
    return true;
  },
});

/** Undo a reservation whose env write failed, so the claim can be retried. */
export const releaseClaim = internalMutation({
  args: { login: v.string() },
  returns: v.null(),
  handler: async (ctx, { login }) => {
    const row = await ctx.db
      .query("setup")
      .withIndex("by_kind_and_value", (q) => q.eq("kind", "claim").eq("value", login))
      .first();
    if (row) await ctx.db.delete("setup", row._id);
    return null;
  },
});

/** A pending GitHub App creation: the state GitHub echoes back, valid for 1 hour. */
export const startGithubApp = internalMutation({
  args: { state: v.string(), by: v.string() },
  returns: v.null(),
  handler: async (ctx, { state, by }) => {
    await ctx.db.insert("setup", { kind: "github-app", value: state, by, at: Date.now() });
    return null;
  },
});

/** Consume a pending GitHub App state; returns who started it, or null if unknown/expired. */
export const finishGithubApp = internalMutation({
  args: { state: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { state }) => {
    const row = await ctx.db
      .query("setup")
      .withIndex("by_kind_and_value", (q) => q.eq("kind", "github-app").eq("value", state))
      .first();
    if (!row) return null;
    await ctx.db.delete("setup", row._id);
    return Date.now() - row.at < 60 * 60_000 ? row.by : null;
  },
});

// ---------------------------------------------------------------- Convex teams
// Where lanes are created. Tokens stay server-side: queries below return everything but the token.

export const convexTeams = internalQuery({
  args: {},
  handler: async (ctx) => {
    const teams = await ctx.db.query("convexTeams").take(50);
    const repos = await ctx.db.query("repos").take(200);
    return teams.map((t) => ({
      id: t._id,
      label: t.label,
      teamId: t.teamId,
      addedBy: t.addedBy,
      at: t.at,
      repos: repos.filter((r) => r.convexTeamId === t._id).map((r) => r.repo),
    }));
  },
});

export const addConvexTeam = internalMutation({
  args: { label: v.string(), teamId: v.number(), token: v.string(), by: v.string() },
  returns: v.id("convexTeams"),
  handler: async (ctx, args) => {
    // One connection per team: adding the same team again replaces its token.
    const same = (await ctx.db.query("convexTeams").take(50)).find((t) => t.teamId === args.teamId);
    if (same) {
      await ctx.db.patch("convexTeams", same._id, { token: args.token, label: args.label || same.label, addedBy: args.by, at: Date.now() });
      return same._id;
    }
    return await ctx.db.insert("convexTeams", { label: args.label, teamId: args.teamId, token: args.token, addedBy: args.by, at: Date.now() });
  },
});

export const removeConvexTeam = internalMutation({
  args: { id: v.id("convexTeams") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const users = (await ctx.db.query("repos").take(200)).filter((r) => r.convexTeamId === id).map((r) => r.repo);
    if (users.length) throw new Error(`Still used by ${users.join(", ")}. Move those repos to another team first.`);
    await ctx.db.delete("convexTeams", id);
    return null;
  },
});

export const convexTeamToken = internalQuery({
  args: { id: v.id("convexTeams") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { id }) => (await ctx.db.get("convexTeams", id))?.token ?? null,
});

/** The token that creates a repo's lanes: its Convex team's, else null (CONVEX_TEAM_TOKEN). */
export const tokenForRepo = internalQuery({
  args: { repo: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { repo }) => {
    const r = await ctx.db
      .query("repos")
      .withIndex("by_repo", (q) => q.eq("repo", repo))
      .unique();
    if (!r?.convexTeamId) return null;
    return (await ctx.db.get("convexTeams", r.convexTeamId))?.token ?? null;
  },
});
