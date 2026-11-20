import { httpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { hmacSha256Hex, sha256Hex, timingSafeEqual } from "./lib/crypto";
import { PAGE_HTML } from "./page";

const http = httpRouter();

// ---------------------------------------------------------------- helpers

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function authed(ctx: ActionCtx, req: Request): Promise<string> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "missing bearer token (set LANE_TOKEN)");
  const t = await ctx.runQuery(internal.admin.tokenByHash, { hash: await sha256Hex(token) });
  if (!t) throw new HttpError(401, "invalid or revoked token");
  return t.person;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  let data: unknown;
  try {
    data = await req.json();
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new HttpError(400, "body must be a JSON object");
  }
  return data as Record<string, unknown>;
}

function str(b: Record<string, unknown>, k: string): string {
  const val = b[k];
  if (typeof val !== "string" || val.length === 0 || val.length > 500) {
    throw new HttpError(400, `"${k}" must be a non-empty string`);
  }
  return val;
}

function optStr(b: Record<string, unknown>, k: string): string | undefined {
  return b[k] === undefined || b[k] === null ? undefined : str(b, k);
}

function bool(b: Record<string, unknown>, k: string): boolean {
  return b[k] === true;
}

function route(
  path: string,
  method: "GET" | "POST",
  fn: (ctx: ActionCtx, req: Request) => Promise<unknown>,
) {
  http.route({
    path,
    method,
    handler: httpAction(async (ctx, req) => {
      try {
        return json(await fn(ctx, req));
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        const msg = e instanceof Error ? e.message : String(e);
        return json({ error: msg.replace(/^Uncaught Error: /, "").split("\n")[0] }, 400);
      }
    }),
  });
  http.route({
    path,
    method: "OPTIONS",
    handler: httpAction(async () => new Response(null, { status: 204, headers: CORS })),
  });
}

// ---------------------------------------------------------------- pages

const page = httpAction(async () => new Response(PAGE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
http.route({ path: "/", method: "GET", handler: page });
http.route({ path: "/lane", method: "GET", handler: page });

// ---------------------------------------------------------------- lanes

route("/api/whoami", "GET", async (ctx, req) => ({ person: await authed(ctx, req) }));

route("/api/lanes", "GET", async (ctx, req) => {
  await authed(ctx, req);
  return await ctx.runQuery(internal.lanes.list, { now: Date.now() });
});

route("/api/lane", "GET", async (ctx, req) => {
  await authed(ctx, req);
  const u = new URL(req.url);
  const repo = u.searchParams.get("repo");
  const branch = u.searchParams.get("branch");
  if (!repo || !branch) throw new HttpError(400, "repo and branch are required");
  const view = await ctx.runQuery(internal.lanes.view, { repo, branch, now: Date.now() });
  if (!view) throw new HttpError(404, `no lane for ${repo}@${branch}`);
  return view;
});

route("/api/lane/ensure", "POST", async (ctx, req) => {
  const person = await authed(ctx, req);
  const b = await body(req);
  return await ctx.runMutation(internal.lanes.ensure, {
    repo: str(b, "repo"),
    branch: str(b, "branch"),
    headSha: optStr(b, "headSha"),
    actor: person,
  });
});

route("/api/lane/push", "POST", async (ctx, req) => {
  const person = await authed(ctx, req);
  const b = await body(req);
  return await ctx.runMutation(internal.lanes.push, {
    repo: str(b, "repo"),
    branch: str(b, "branch"),
    sha: str(b, "sha"),
    convexChanged: bool(b, "convexChanged"),
    actor: optStr(b, "actor") ?? person,
  });
});

route("/api/lane/down", "POST", async (ctx, req) => {
  const person = await authed(ctx, req);
  const b = await body(req);
  const res = await ctx.runMutation(internal.lanes.archive, {
    repo: str(b, "repo"),
    branch: str(b, "branch"),
    actor: person,
    reason: optStr(b, "reason") ?? "lane down",
  });
  return res ?? { alreadyDown: true };
});

route("/api/lane/key", "POST", async (ctx, req) => {
  const person = await authed(ctx, req);
  const b = await body(req);
  const info = await ctx.runQuery(internal.lanes.laneIdFor, { repo: str(b, "repo"), branch: str(b, "branch") });
  if (!info || info.state !== "ready" || !info.deploymentName) throw new HttpError(409, "lane is not ready");
  const minted = await ctx.runAction(internal.provision.mintKey, {
    laneId: info.laneId,
    deploymentName: info.deploymentName,
    holder: optStr(b, "holder") ?? person,
    purpose: "agent",
  });
  return minted;
});

route("/api/lane/event", "POST", async (ctx, req) => {
  const person = await authed(ctx, req);
  const b = await body(req);
  await ctx.runMutation(internal.lanes.logLaneEvent, {
    repo: str(b, "repo"),
    branch: str(b, "branch"),
    type: str(b, "type"),
    detail: str(b, "detail"),
    actor: optStr(b, "actor") ?? person,
  });
  return { ok: true };
});

// ---------------------------------------------------------------- deployer

route("/api/deploy/claim", "POST", async (ctx, req) => {
  const person = await authed(ctx, req);
  const b = await body(req);
  const repo = str(b, "repo");
  const holder = optStr(b, "holder") ?? person;
  const claim = await ctx.runMutation(internal.lanes.claimDeploy, {
    repo,
    branch: str(b, "branch"),
    holder,
    force: bool(b, "force"),
  });
  if (claim.status !== "claimed") return claim;
  const minted = await ctx.runAction(internal.provision.mintKey, {
    laneId: claim.laneId,
    deploymentName: claim.deploymentName,
    holder,
    purpose: "deployer",
  });
  const cfg = await ctx.runQuery(internal.admin.repoConfig, { repo });
  return {
    status: claim.status,
    sha: claim.sha,
    deployKey: minted.key,
    seedFunction: claim.needSeed ? cfg?.seedFunction ?? null : null,
  };
});

route("/api/deploy/finish", "POST", async (ctx, req) => {
  const person = await authed(ctx, req);
  const b = await body(req);
  return await ctx.runMutation(internal.lanes.finishDeploy, {
    repo: str(b, "repo"),
    branch: str(b, "branch"),
    holder: optStr(b, "holder") ?? person,
    sha: str(b, "sha"),
    ok: bool(b, "ok"),
    seeded: bool(b, "seeded"),
    detail: typeof b.detail === "string" ? b.detail.slice(0, 2000) : "",
  });
});

// ---------------------------------------------------------------- agents

route("/api/agents/join", "POST", async (ctx, req) => {
  const person = await authed(ctx, req);
  const b = await body(req);
  const repo = str(b, "repo");
  const branch = str(b, "branch");
  const agentId = await ctx.runMutation(internal.lanes.join, {
    repo,
    branch,
    vendor: str(b, "vendor"),
    person: optStr(b, "person") ?? person,
    task: str(b, "task"),
    machine: optStr(b, "machine") ?? "unknown",
    threadUrl: optStr(b, "threadUrl"),
    agentId: optStr(b, "agentId") as Id<"laneAgents"> | undefined,
  });
  return { agentId };
});

route("/api/agents/heartbeat", "POST", async (ctx, req) => {
  await authed(ctx, req);
  const b = await body(req);
  const status = str(b, "status");
  if (status !== "working" && status !== "waiting" && status !== "done") {
    throw new HttpError(400, "status must be working, waiting or done");
  }
  await ctx.runMutation(internal.lanes.heartbeat, {
    agentId: str(b, "agentId") as Id<"laneAgents">,
    status,
    task: optStr(b, "task"),
    lastSha: optStr(b, "lastSha"),
  });
  return { ok: true };
});

// ---------------------------------------------------------------- GitHub

http.route({
  path: "/github/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    const raw = await req.text();
    const sig = req.headers.get("x-hub-signature-256") ?? "";
    if (!secret || !timingSafeEqual(sig, "sha256=" + (await hmacSha256Hex(secret, raw)))) {
      return json({ error: "bad signature" }, 401);
    }
    let p: Record<string, any>;
    try {
      p = JSON.parse(raw);
    } catch {
      return json({ error: "bad json" }, 400);
    }
    const event = req.headers.get("x-github-event");
    const repo: unknown = p.repository?.full_name;
    if (typeof repo !== "string") return json({ ignored: "no repository" });

    if (event === "push" && typeof p.ref === "string" && p.ref.startsWith("refs/heads/")) {
      const branch = p.ref.slice("refs/heads/".length);
      if (p.deleted === true) {
        return json(await ctx.runMutation(internal.lanes.archive, { repo, branch, actor: "github", reason: "branch deleted" }));
      }
      const commits: Array<Record<string, unknown>> = Array.isArray(p.commits) ? p.commits : [];
      const touched = commits.flatMap((c) =>
        ["added", "modified", "removed"].flatMap((k) => (Array.isArray(c[k]) ? (c[k] as string[]) : [])),
      );
      // GitHub truncates commit lists past 20 commits; treat that as "maybe changed".
      const convexChanged = commits.length >= 20 || touched.some((f) => f.startsWith("convex/"));
      const res = await ctx.runMutation(internal.lanes.push, {
        repo,
        branch,
        sha: String(p.after),
        convexChanged,
        actor: `github/${p.pusher?.name ?? "unknown"}`,
      });
      // The lane deployer (a GitHub Action on the same push) does the deploy itself.
      return json(res);
    }
    if (event === "pull_request") {
      const branch: unknown = p.pull_request?.head?.ref;
      if (typeof branch !== "string") return json({ ignored: "no head ref" });
      if (p.action === "opened" || p.action === "reopened") {
        return json(
          await ctx.runMutation(internal.lanes.ensure, {
            repo,
            branch,
            headSha: p.pull_request?.head?.sha,
            actor: `github/${p.sender?.login ?? "unknown"}`,
          }),
        );
      }
      if (p.action === "closed") {
        return json(
          await ctx.runMutation(internal.lanes.archive, {
            repo,
            branch,
            actor: `github/${p.sender?.login ?? "unknown"}`,
            reason: p.pull_request?.merged ? "PR merged" : "PR closed",
          }),
        );
      }
    }
    return json({ ignored: event });
  }),
});

export default http;
