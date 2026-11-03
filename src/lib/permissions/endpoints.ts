import { can, type Decision } from "./can";
import type { Action } from "./matrix";

/**
 * Every `/api/v1` endpoint, classified by who may call it (PRD 5.1, SIT-249). The matrix tests are generated from this table
 * and from the permission module (`can`): `endpoints.test.ts` fails when a route file has no entry here (or an entry has no
 * route), and `endpoint-matrix.integration.test.ts` calls every entry as every kind of caller and compares the real status
 * with `expectedOutcome`. A new endpoint therefore fails CI until someone decides, here, who may call it.
 *
 * - `org`: inside a workspace (`X-Organization-Id`); a member's role and the workspace kind decide, via the permission matrix.
 * - `signed-in`: any signed-in caller, guests included; no workspace needed.
 * - `registered`: a signed-in caller with a real account; demo guests are refused.
 * - `guest-only`: demo guests only; registered users are refused.
 * - `member-of-path`: a workspace named in the path; only its members (anyone else gets 404).
 */
export type EndpointRule =
  | { who: "org"; action: Action }
  | { who: "signed-in" }
  | { who: "registered" }
  | { who: "guest-only" }
  | { who: "member-of-path" };

const read: EndpointRule = { who: "org", action: "records.read" };
const write: EndpointRule = { who: "org", action: "records.write" };
const manage: EndpointRule = { who: "org", action: "members.manage" };
const exportRun: EndpointRule = { who: "org", action: "export.run" };
const quoteWrite: EndpointRule = { who: "org", action: "quotes.write" };

/** Keyed `"METHOD /path"` with `{param}` placeholders, exactly as the route files are laid out. */
export const ENDPOINTS: Record<string, EndpointRule> = {
  "GET /activity": read,
  "GET /customers": read,
  "POST /customers": write,
  "GET /customers/{id}": read,
  "PATCH /customers/{id}": write,
  "DELETE /customers/{id}": write,
  "POST /customers/{id}/restore": write,
  "GET /dashboard": read,
  "GET /reports": read,
  "POST /demo/bootstrap": { who: "guest-only" },
  "POST /demo/reset": { who: "guest-only" },
  "POST /imports/customers/commit": write,
  "GET /imports/customers/{jobId}/errors": read,
  "POST /imports/customers/preview": write,
  "GET /invitations": manage,
  "POST /invitations": manage,
  "DELETE /invitations/{id}": manage,
  "POST /invitations/accept": { who: "registered" },
  "POST /invitations/preview": { who: "registered" },
  "GET /members": read,
  "PATCH /members/{userId}": manage,
  "DELETE /members/{userId}": manage,
  "GET /opportunities": read,
  "POST /opportunities": write,
  "GET /opportunities/{id}": read,
  "PATCH /opportunities/{id}": write,
  "DELETE /opportunities/{id}": write,
  "POST /opportunities/{id}/stage": write,
  "GET /organizations": { who: "signed-in" },
  "POST /organizations": { who: "registered" },
  "GET /organizations/{id}": { who: "member-of-path" },
  "PATCH /organizations/{id}": { who: "org", action: "org.settings.update" },
  "GET /quotes": read,
  "POST /quotes": quoteWrite,
  "GET /quotes/{id}": read,
  "PATCH /quotes/{id}": quoteWrite,
  "GET /quotes/{id}/pdf": exportRun,
  "POST /quotes/{id}/transition": quoteWrite,
  "POST /quotes/{id}/revise": quoteWrite,
  "GET /session": { who: "signed-in" },
  "GET /tasks": read,
  "POST /tasks": write,
  "GET /tasks/{id}": read,
  "PATCH /tasks/{id}": write,
  "DELETE /tasks/{id}": write,
  "POST /tasks/{id}/complete": write,
};

/** Who is calling. A guest is a signed-in anonymous user; `membership` is their role in the workspace the request names. */
export type Caller =
  | { signedIn: false }
  | {
      signedIn: true;
      anonymous: boolean;
      membership: { role: string; kind: string } | null;
    };

export type Outcome = "401" | "403" | "404" | "allowed";

function fromDecision(d: Decision): Outcome {
  return d.allowed ? "allowed" : "403";
}

/**
 * The status class the API must answer for this caller, from the rules above and the permission module. `allowed` means
 * "not refused": the request got past authorization (the handler may still answer 200, 204, 404 for a missing record,
 * 409 or 422 for a business rule).
 */
export function expectedOutcome(rule: EndpointRule, caller: Caller): Outcome {
  if (!caller.signedIn) return "401";
  switch (rule.who) {
    case "org":
      if (!caller.membership) return "404";
      return fromDecision(can(caller.membership.role, caller.membership.kind, rule.action));
    case "signed-in":
      return "allowed";
    case "registered":
      return caller.anonymous ? "403" : "allowed";
    case "guest-only":
      return caller.anonymous ? "allowed" : "403";
    case "member-of-path":
      return caller.membership ? "allowed" : "404";
  }
}
