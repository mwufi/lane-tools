// Thin wrappers over Convex's Management API (api.convex.dev/v1) and the
// per-deployment admin API. Only the control plane holds the team token.

const API = "https://api.convex.dev/v1";

function teamToken(): string {
  const t = process.env.CONVEX_TEAM_TOKEN;
  if (!t) throw new Error("CONVEX_TEAM_TOKEN is not set on the control plane");
  return t;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${teamToken()}`,
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

export async function createDeployment(projectId: number, reference: string): Promise<Deployment> {
  // "dev" deployments have no expiry; lanes are deleted on merge instead.
  return await call<Deployment>("POST", `/projects/${projectId}/create_deployment`, {
    type: "dev",
    reference,
  });
}

export async function deleteDeployment(name: string): Promise<void> {
  await call("POST", `/deployments/${name}/delete`);
}

export const DEPLOYER_ACTIONS = [
  "deployment:deploy",
  "deployment:env:view",
  "deployment:logs:view",
  "deployment:functions:runInternalQueries",
  "deployment:functions:runInternalMutations",
  "deployment:functions:runInternalActions",
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
): Promise<string> {
  const res = await call<{ deployKey: string }>(
    "POST",
    `/deployments/${deploymentName}/create_deploy_key`,
    { name, allowedActions, expiresAt: Date.now() + Math.max(ttlMs, 31 * 60_000) },
  );
  return res.deployKey;
}

export async function deleteDeployKey(deploymentName: string, name: string): Promise<void> {
  await call("POST", `/deployments/${deploymentName}/delete_deploy_key`, { id: name });
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
