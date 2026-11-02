import type { SupabaseClient } from "@supabase/supabase-js";
import type { CurrentUser } from "@/lib/supabase/resolve-user";
import { uuid } from "@/lib/validation/primitives";
import { BadRequestError, ForbiddenError, NotFoundError, ValidationError } from "./errors";

/**
 * Which organization an API call acts on (PRD 7.4). Convention: **the `X-Organization-Id` request header**,
 * a UUID, on every /api/v1 call that touches tenant data. It is a selector, never an authorization: each
 * request re-proves membership with a read under the caller's own session (RLS applies), and the role comes
 * from that read, never from the client. A cookie or local-storage copy of the id is only a UI preference.
 */
export const ORG_HEADER = "X-Organization-Id";

export type OrgRole = "owner" | "admin" | "member" | "viewer";
export type OrgKind = "real" | "demo";

export type OrgContext = {
  user: CurrentUser;
  org: { id: string; name: string; kind: OrgKind; expiresAt: string | null; timezone: string };
  /** From the database (the caller's membership), never from the request. */
  role: OrgRole;
  kind: OrgKind;
  /** True for a demo workspace past its expiry (only returned when the caller allowed expired demos). */
  expired: boolean;
};

export type MembershipRow = {
  role: string;
  organizations: {
    id: string;
    name: string;
    kind: string;
    expires_at: string | null;
    timezone: string;
  } | null;
};

/** The caller's own memberships, read with their session so RLS decides what exists. */
export async function loadMemberships(
  supabase: SupabaseClient<any, any, any>, // eslint-disable-line @typescript-eslint/no-explicit-any -- generic over any Database
  userId: string,
): Promise<MembershipRow[]> {
  const { data, error } = await supabase
    .from("memberships")
    .select("role, organizations(id, name, kind, expires_at, timezone)")
    .eq("user_id", userId)
    .limit(100);
  if (error) throw error;
  return (data ?? []) as unknown as MembershipRow[];
}

export class DemoExpiredError extends ForbiddenError {
  constructor() {
    super("This demo has expired. Start a new one to keep exploring.", "DEMO_EXPIRED");
  }
}

const NOT_FOUND_MESSAGE = "That workspace was not found.";

export type SelectOptions = {
  /** Let an expired demo through (with `expired: true`), for endpoints that must still answer, such as the session. Default: refuse. */
  allowExpired?: boolean;
  now?: Date;
};

/**
 * Chooses the organization from the header and the caller's verified memberships.
 *
 * - Header present: that organization if the caller is a member, else **404** (the same answer for an unknown
 *   id and for another tenant's id, so existence never leaks). A malformed id is a 400.
 * - Header absent: the only membership if there is exactly one; **422 `ORG_SELECTION_REQUIRED`** when there
 *   are several (no silent default); 404 `NO_WORKSPACE` when there are none.
 * - An expired demo is refused with 403 `DEMO_EXPIRED` unless `allowExpired`.
 */
export function selectOrg(
  user: CurrentUser,
  memberships: readonly MembershipRow[],
  header: string | null,
  options: SelectOptions = {},
): OrgContext {
  // Rows whose organization is hidden cannot be used (RLS said no).
  const visible = memberships.filter(
    (m): m is MembershipRow & { organizations: NonNullable<MembershipRow["organizations"]> } =>
      m.organizations !== null,
  );

  let chosen: (typeof visible)[number] | undefined;
  const value = header?.trim() ?? "";
  if (value !== "") {
    const parsed = uuid().safeParse(value);
    if (!parsed.success) throw new BadRequestError(`${ORG_HEADER} must be a valid workspace ID.`);
    chosen = visible.find((m) => m.organizations.id === parsed.data);
    if (!chosen) throw new NotFoundError(NOT_FOUND_MESSAGE, "ORG_NOT_FOUND");
  } else if (visible.length === 1) {
    chosen = visible[0];
  } else if (visible.length === 0) {
    throw new NotFoundError("Create a workspace to continue.", "NO_WORKSPACE");
  } else {
    throw new ValidationError(
      `You belong to several workspaces. Choose one by sending the ${ORG_HEADER} header.`,
      { [ORG_HEADER]: ["Choose a workspace."] },
      "ORG_SELECTION_REQUIRED",
    );
  }

  const o = chosen.organizations;
  const kind: OrgKind = o.kind === "demo" ? "demo" : "real";
  const now = options.now ?? new Date();
  const expired =
    kind === "demo" && (o.expires_at === null || new Date(o.expires_at).getTime() <= now.getTime());
  if (expired && !options.allowExpired) throw new DemoExpiredError();

  return {
    user,
    org: { id: o.id, name: o.name, kind, expiresAt: o.expires_at, timezone: o.timezone },
    role: chosen.role as OrgRole,
    kind,
    expired,
  };
}

/** Header-reading entry point: `resolveOrg(request, user, supabase)`. */
export async function resolveOrg(
  request: Request,
  user: CurrentUser,
  supabase: SupabaseClient<any, any, any>, // eslint-disable-line @typescript-eslint/no-explicit-any -- generic over any Database
  options: SelectOptions = {},
): Promise<OrgContext> {
  const header = request.headers.get(ORG_HEADER);
  // Only fetch memberships once the header is plausible, so junk input never reaches the database.
  if (header !== null && header.trim() !== "" && !uuid().safeParse(header.trim()).success) {
    throw new BadRequestError(`${ORG_HEADER} must be a valid workspace ID.`);
  }
  return selectOrg(user, await loadMemberships(supabase, user.id), header, options);
}
