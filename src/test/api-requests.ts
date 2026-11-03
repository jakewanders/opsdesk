/**
 * One request builder per classified endpoint, shared by the endpoint x caller matrix (SIT-249) and the API contract matrix (P-05).
 * The bodies are chosen so that a caller who is allowed in gets a deterministic non-authorization answer: a stale version (409),
 * an unknown id (404), or a plain success for the creating endpoints. Add a builder here when `ENDPOINTS` gains a route.
 */
export type Ids = { customer: string; opportunity: string; task: string; quote: string };
export type Req = { method: string; path: string; json?: unknown };
export type Ctx = { org: string; ids: Ids };

const UNKNOWN = "00000000-0000-4000-8000-000000000999";
/** A long-past version: an allowed caller gets 409 STALE_EDIT (which proves authorization passed), a refused caller 403. */
const STALE = "2020-01-01T00:00:00.000000+00:00";
let counter = 0;
export const nextCounter = () => ++counter;

export const B: Record<string, (c: Ctx) => Req> = {
  "GET /activity": () => ({ method: "GET", path: "/activity" }),
  "GET /customers": () => ({ method: "GET", path: "/customers" }),
  "POST /customers": () => ({
    method: "POST",
    path: "/customers",
    json: { displayName: `Matrix Co ${++counter}` },
  }),
  "GET /customers/{id}": (c) => ({ method: "GET", path: `/customers/${c.ids.customer}` }),
  "PATCH /customers/{id}": (c) => ({
    method: "PATCH",
    path: `/customers/${c.ids.customer}`,
    json: { notes: "matrix", expectedUpdatedAt: STALE },
  }),
  "DELETE /customers/{id}": () => ({ method: "DELETE", path: `/customers/${UNKNOWN}` }),
  "POST /customers/{id}/restore": (c) => ({
    method: "POST",
    path: `/customers/${c.ids.customer}/restore`,
  }),
  "GET /dashboard": () => ({ method: "GET", path: "/dashboard" }),
  "GET /exports/{entity}": () => ({ method: "GET", path: "/exports/customers" }),
  "GET /reports": () => ({ method: "GET", path: "/reports" }),
  "POST /demo/bootstrap": () => ({ method: "POST", path: "/demo/bootstrap" }),
  "POST /demo/reset": () => ({ method: "POST", path: "/demo/reset" }),
  "POST /imports/customers/commit": () => ({
    method: "POST",
    path: "/imports/customers/commit",
    json: { importJobId: UNKNOWN, content: Buffer.from("display_name\nX Y\n").toString("base64") },
  }),
  "GET /imports/customers/{jobId}/errors": () => ({
    method: "GET",
    path: `/imports/customers/${UNKNOWN}/errors`,
  }),
  "POST /imports/customers/preview": () => ({
    method: "POST",
    path: "/imports/customers/preview",
    json: { content: Buffer.from(`display_name\nMatrix Import ${++counter}\n`).toString("base64") },
  }),
  "GET /invitations": () => ({ method: "GET", path: "/invitations" }),
  "POST /invitations": () => ({
    method: "POST",
    path: "/invitations",
    json: { email: `mx-${Date.now()}-${++counter}@example.test`, role: "member" },
  }),
  "DELETE /invitations/{id}": () => ({ method: "DELETE", path: `/invitations/${UNKNOWN}` }),
  "POST /invitations/accept": () => ({
    method: "POST",
    path: "/invitations/accept",
    json: { token: "0".repeat(64) },
  }),
  "POST /invitations/preview": () => ({
    method: "POST",
    path: "/invitations/preview",
    json: { token: "0".repeat(64) },
  }),
  "GET /members": () => ({ method: "GET", path: "/members" }),
  "PATCH /members/{userId}": () => ({
    method: "PATCH",
    path: `/members/${UNKNOWN}`,
    json: { role: "viewer" },
  }),
  "DELETE /members/{userId}": () => ({ method: "DELETE", path: `/members/${UNKNOWN}` }),
  "GET /opportunities": () => ({ method: "GET", path: "/opportunities" }),
  "POST /opportunities": (c) => ({
    method: "POST",
    path: "/opportunities",
    json: { customerId: c.ids.customer, title: `Matrix deal ${++counter}` },
  }),
  "GET /opportunities/{id}": (c) => ({
    method: "GET",
    path: `/opportunities/${c.ids.opportunity}`,
  }),
  "PATCH /opportunities/{id}": (c) => ({
    method: "PATCH",
    path: `/opportunities/${c.ids.opportunity}`,
    json: { description: "matrix", expectedUpdatedAt: STALE },
  }),
  "DELETE /opportunities/{id}": () => ({ method: "DELETE", path: `/opportunities/${UNKNOWN}` }),
  "POST /opportunities/{id}/stage": (c) => ({
    method: "POST",
    path: `/opportunities/${c.ids.opportunity}/stage`,
    json: { stage: "qualified", expectedUpdatedAt: STALE },
  }),
  "GET /organizations": () => ({ method: "GET", path: "/organizations" }),
  "POST /organizations": () => ({
    method: "POST",
    path: "/organizations",
    json: { name: `Matrix Workspace ${++counter}` },
  }),
  "GET /organizations/{id}": (c) => ({ method: "GET", path: `/organizations/${c.org}` }),
  "PATCH /organizations/{id}": (c) => ({
    method: "PATCH",
    path: `/organizations/${c.org}`,
    json: { name: "Matrix Rename", expectedUpdatedAt: STALE },
  }),
  "GET /quotes": () => ({ method: "GET", path: "/quotes" }),
  "POST /quotes": (c) => ({
    method: "POST",
    path: "/quotes",
    json: {
      customerId: c.ids.customer,
      title: `Matrix quote ${++counter}`,
      items: [{ description: "Matrix line", quantity: 1, unitPriceCents: 100 }],
    },
  }),
  "GET /quotes/{id}": (c) => ({ method: "GET", path: `/quotes/${c.ids.quote}` }),
  "GET /quotes/{id}/pdf": (c) => ({ method: "GET", path: `/quotes/${c.ids.quote}/pdf` }),
  "PATCH /quotes/{id}": (c) => ({
    method: "PATCH",
    path: `/quotes/${c.ids.quote}`,
    json: { expectedVersion: 999, title: "matrix" },
  }),
  "POST /quotes/{id}/transition": (c) => ({
    method: "POST",
    path: `/quotes/${c.ids.quote}/transition`,
    json: { to: "sent", expectedVersion: 999 },
  }),
  "POST /quotes/{id}/revise": (c) => ({ method: "POST", path: `/quotes/${c.ids.quote}/revise` }),
  "GET /session": () => ({ method: "GET", path: "/session" }),
  "GET /tasks": () => ({ method: "GET", path: "/tasks" }),
  "POST /tasks": () => ({
    method: "POST",
    path: "/tasks",
    json: { title: `Matrix task ${++counter}` },
  }),
  "GET /tasks/{id}": (c) => ({ method: "GET", path: `/tasks/${c.ids.task}` }),
  "PATCH /tasks/{id}": (c) => ({
    method: "PATCH",
    path: `/tasks/${c.ids.task}`,
    json: { description: "matrix", expectedUpdatedAt: STALE },
  }),
  "DELETE /tasks/{id}": () => ({ method: "DELETE", path: `/tasks/${UNKNOWN}` }),
  "POST /tasks/{id}/complete": (c) => ({
    method: "POST",
    path: `/tasks/${c.ids.task}/complete`,
    json: { completed: false, expectedUpdatedAt: STALE },
  }),
};
