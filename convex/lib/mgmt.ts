// Thin wrappers over Convex's Management API (api.convex.dev/v1) and the
// per-deployment admin API. Only the control plane holds the team token.

// Overridable so the whole setup flow can be tested against a local mock.
const API = process.env.LANE_MGMT_API_URL ?? "https://api.convex.dev/v1";

function teamToken(): string {
  const t = process.env.CONVEX_TEAM_TOKEN;
  if (!t) throw new Error("CONVEX_TEAM_TOKEN is not set on the control plane");
  return t;
}

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token ?? teamToken()}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Management API ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export type Deployment = { name: string; deploymentUrl: string; reference: string };

export async function createDeployment(projectId: number, reference: string, token?: string): Promise<Deployment> {
  // A preview deployment, so the dashboard and CLI show the branch. Previews expire by
  // default; lanes clear that and are deleted on merge instead.
  return await call<Deployment>("POST", `/projects/${projectId}/create_deployment`, {
    type: "preview",
    reference,
    expiresAt: null,
  }, token);
}

/** Rename a deployment (its "reference"), e.g. when a warm-pool spare is claimed by a branch. */
export async function setDeploymentReference(name: string, reference: string, token?: string): Promise<void> {
  await call("PATCH", `/deployments/${name}`, { reference }, token);
}

export async function deleteDeployment(name: string, token?: string): Promise<void> {
  await call("POST", `/deployments/${name}/delete`, undefined, token);
}

export const DEPLOYER_ACTIONS = [
  "deployment:deploy",
  "deployment:env:view",
  "deployment:logs:view",
  "deployment:functions:runInternalQueries",
  "deployment:functions:runInternalMutations",
  "deployment:functions:runInternalActions",
];

// Importing and exporting seed snapshots (`npx convex import` / `export`), on its own short-lived key
// so a deploy never depends on these permissions.
export const SEED_ACTIONS = [
  "deployment:backups:create",
  // `convex export` and `convex import` poll the backup they start; without this both are refused.
  "deployment:backups:view",
  "deployment:backups:download",
  "deployment:backups:import",
  "deployment:data:view",
  "deployment:data:write",
];

export const AGENT_ACTIONS = [
  ...DEPLOYER_ACTIONS,
  "deployment:data:view",
  "deployment:functions:runTestQuery",
];

export async function createDeployKey(
  deploymentName: string,
  name: string,
  allowedActions: string[],
  ttlMs: number,
  token?: string, // a team token other than CONVEX_TEAM_TOKEN (setup: proving ownership)
): Promise<string> {
  const res = await call<{ deployKey: string }>(
    "POST",
    `/deployments/${deploymentName}/create_deploy_key`,
    { name, allowedActions, expiresAt: Date.now() + Math.max(ttlMs, 31 * 60_000) },
    token,
  );
  return res.deployKey;
}

export async function deleteDeployKey(deploymentName: string, name: string, token?: string): Promise<void> {
  await call("POST", `/deployments/${deploymentName}/delete_deploy_key`, { id: name }, token);
}

/** The team a token belongs to, and that team's projects. */
export async function inspectTeamToken(
  token?: string,
): Promise<{ teamId: number; projects: Array<{ id: number; name: string; slug: string }> }> {
  const t = await call<{ teamId: number }>("GET", "/token_details", undefined, token);
  const projects = await call<Array<{ id: number; name: string; slug: string }>>("GET", `/teams/${t.teamId}/list_projects`, undefined, token);
  return { teamId: t.teamId, projects };
}

/** Whether an admin or deploy key works on a deployment (a read-only call). */
export async function keyWorks(deploymentUrl: string, key: string): Promise<boolean> {
  const res = await fetch(`${deploymentUrl}/api/v1/list_environment_variables`, { headers: { Authorization: `Convex ${key}` } });
  return res.ok;
}

export async function setDeploymentEnv(
  deploymentUrl: string,
  adminKey: string,
  env: Record<string, string | null>, // null removes the variable
): Promise<void> {
  const changes = Object.entries(env).map(([name, value]) => ({ name, value }));
  if (changes.length === 0) return;
  const res = await fetch(`${deploymentUrl}/api/v1/update_environment_variables`, {
    method: "POST",
    headers: { Authorization: `Convex ${adminKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ changes }),
  });
  if (!res.ok) throw new Error(`env update -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

export function siteUrlFor(deploymentUrl: string): string {
  return deploymentUrl.replace(/\.convex\.cloud$/, ".convex.site");
}
