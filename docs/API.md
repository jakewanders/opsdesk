# API conventions (/api/v1)

The contract every route handler follows (PRD 7.3). It is implemented once in `src/lib/api` and applied with `withApi`; `docs/openapi.yaml` (P-19) is generated from these rules and lists only implemented routes.

## Writing a route handler

```ts
// src/app/api/v1/things/route.ts
import { okList, created } from "@/lib/api/envelope";
import { withApi } from "@/lib/api/handler";
import { readJson } from "@/lib/api/json-body";

export const GET = withApi(async () =>
  okList(await listThings(), { page: 1, limit: 25, total: 1, totalPages: 1 }),
);

export const POST = withApi(async ({ request }) => {
  const input = createThingSchema.parse(await readJson(request)); // a ZodError becomes 422 with fieldErrors
  return created(await createThing(input));
});

// dynamic segment
export const GET = withApi<{ id: string }>(async ({ params }) => okItem(await getThing(params.id)));
```

Throw to fail: `throw new NotFoundError()`, or let a Zod or database error propagate. Never build an error response by hand.

## Success

`{ "data": <object | array>, "meta": { ... } }`. `meta` is always present (`{}` when empty). An item endpoint always returns an **object** in `data` (`okItem`, `created`); a list endpoint always returns an **array** (`okList`, an empty list is `[]`), so the shape of `data` never switches. List `meta`: `page`, `limit`, `total`, `totalPages`. `204` has no body.

## Errors

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Please correct the highlighted fields.",
    "fieldErrors": { "email": ["Invalid email address"] },
    "requestId": "3f1c2d4e-..."
  }
}
```

`code` is for programs, `message` is written for the user, `fieldErrors` (optional) maps field names (dotted for nesting, `_form` for form-level) to messages, `requestId` matches the `X-Request-Id` response header. `meta` (optional) carries machine-readable context, for example the current version on a stale edit.

| HTTP | `code`                                                                                                                                                                                        | Meaning                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 400  | `BAD_REQUEST`                                                                                                                                                                                 | malformed request: invalid JSON, a bad id format                                                             |
| 401  | `UNAUTHENTICATED`                                                                                                                                                                             | no valid session                                                                                             |
| 403  | `FORBIDDEN`                                                                                                                                                                                   | signed in, but role or workspace may not do this                                                             |
| 404  | `NOT_FOUND`                                                                                                                                                                                   | record missing **or in another tenant** (never distinguished)                                                |
| 409  | `STALE_EDIT`, `IDEMPOTENCY_IN_PROGRESS`, `CONFLICT`, `DUPLICATE`                                                                                                                              | stale edit (current value in `error.meta.current`), a duplicate request still running, or a unique violation |
| 413  | `PAYLOAD_TOO_LARGE`                                                                                                                                                                           | JSON body over the cap (enforced by SIT-181)                                                                 |
| 415  | `UNSUPPORTED_MEDIA_TYPE`                                                                                                                                                                      | a body that is not `application/json` (an addition to the PRD list; see `docs/DECISIONS.md`)                 |
| 422  | `VALIDATION_ERROR`, `IDEMPOTENCY_KEY_INVALID`, `IDEMPOTENCY_KEY_REUSED`, `INVALID_REFERENCE`, `CHECK_VIOLATION`, `REQUIRED_VALUE`, `VALUE_TOO_LONG`, `VALUE_OUT_OF_RANGE`, or a business code | well-formed but invalid, or a rule refuses it                                                                |
| 429  | `RATE_LIMITED` or a business code (for example `DEMO_QUOTA`)                                                                                                                                  | quota or throttle; `Retry-After` header when known                                                           |
| 500  | `INTERNAL_ERROR`                                                                                                                                                                              | anything unexpected. Always the same generic message; the cause is logged server-side against the request ID |

Every response, success or error, carries `X-Request-Id` and `Cache-Control: no-store`, and `Content-Type: application/json; charset=utf-8` when it has a body.

## Request IDs

A request ID is generated per request. A caller-supplied `X-Request-Id` is accepted only when it is 8 to 64 characters of letters, digits, `-` or `_`; anything else is replaced with a fresh UUID (so a caller cannot forge or break log lines). The ID is passed to handlers (`requestId`), echoed in the header and in every error body. A user quotes it to find the server log entry.

## Request bodies

A request with a body must be `application/json` (or `application/*+json`); otherwise 415. A request with no body is always fine. `readJson(request)` parses the body (400 for invalid or empty JSON) and returns `unknown`: validate it with Zod before use. The size cap is added by SIT-181.

## Database errors

Handlers do not catch database errors; `withApi` maps them (`src/lib/api/postgres-errors.ts`) with **fixed messages**, so SQL text, constraint names, and values never reach a client:

| SQLSTATE                                                   | HTTP | `code`                                  |
| ---------------------------------------------------------- | ---- | --------------------------------------- |
| 23505 unique                                               | 409  | `DUPLICATE`                             |
| 23503 foreign key (including cross-tenant)                 | 422  | `INVALID_REFERENCE`                     |
| 23514 check                                                | 422  | `CHECK_VIOLATION`                       |
| 23502 not null                                             | 422  | `REQUIRED_VALUE`                        |
| 22001 / 22003                                              | 422  | `VALUE_TOO_LONG` / `VALUE_OUT_OF_RANGE` |
| 22P02 / 22007 / 22008 bad format                           | 400  | `BAD_REQUEST`                           |
| 42501 privilege or RLS denial on write                     | 403  | `FORBIDDEN`                             |
| PGRST116 no row for `.single()`                            | 404  | `NOT_FOUND`                             |
| PGRST301 / PGRST303 JWT expired or invalid                 | 401  | `UNAUTHENTICATED`                       |
| anything else, including a plain `RAISE EXCEPTION` (P0001) | 500  | `INTERNAL_ERROR`                        |

### Refusing a request on purpose from SQL

RPCs and triggers that must return a specific 4xx raise a custom SQLSTATE in the `OD` class. The `message` is shown to the user, so write it for them:

```sql
raise exception using errcode = 'OD429',
                      message = 'Demo limit reached: customers.',
                      detail  = 'DEMO_QUOTA',        -- optional machine code (UPPER_SNAKE_CASE) -> error.code
                      hint    = 'retry-after=60';    -- optional, OD429 only -> Retry-After header
```

| SQLSTATE | HTTP | Use for                                              |
| -------- | ---- | ---------------------------------------------------- |
| `OD403`  | 403  | the caller may not do this (a guest, the wrong role) |
| `OD404`  | 404  | record missing or in another tenant                  |
| `OD409`  | 409  | stale edit, state conflict                           |
| `OD422`  | 422  | a business rule refuses it                           |
| `OD429`  | 429  | quota or throttle                                    |

Tested against the real local database in `src/lib/api/postgres-errors.integration.test.ts`.

## Permission checks in handlers

Check the caller's role before touching data, using the permission module (`src/lib/permissions`, the matrix in `docs/SECURITY.md`):

```ts
import { assertCan } from "@/lib/permissions";

export const POST = withApi(async ({ request }) => {
  const org = await resolveActiveOrg(request);            // SIT-193: membership proven, never trusted from the header
  const { constraints } = assertCan(org.role, org.kind, "records.write"); // throws a 403 envelope
  // honor `constraints` (for example "demo_quota_limited"); RLS still re-checks the write
  ...
});
```

A role denial is `403 FORBIDDEN`; a demo-workspace restriction is `403 DEMO_RESTRICTED` with a message the UI can show. An unknown role, kind, or action is always denied. This check comes before the database and never replaces it: every write is re-checked by RLS. For membership changes use `canChangeMembership` and `grantableRoles`.

## Validation and query parsing (SIT-182)

Everything lives in `src/lib/validation` (`import { ... } from "@/lib/validation"`).

- **Plain text only.** Free text is stored exactly as typed (trimmed, NFC-normalized) and rendered only through React's escaping; nothing is ever inserted as HTML. As defence in depth the text schemas also reject tag-like input (`<` followed by a letter, `/`, `!` or `?`), so markup is a 422 rather than stored data. A bare `<` in prose ("revenue < costs") is fine.
- **Length is counted in code points**, the same unit as Postgres `varchar(n)`, so an emoji counts as 1 and a value that passes validation cannot fail a database length check.
- Single-line fields (`singleLine(max, min?)`) reject control characters, line breaks, zero-width and bidirectional override characters; `multiLine(max)` allows line breaks (CRLF becomes LF) but still rejects controls and tags. `optionalSingleLine`/`optionalMultiLine` turn blank into `null`.
- Primitives: `uuid()`, `isoDate()` (real calendar days, `YYYY-MM-DD`), `cents(max = MAX_CENTS)` (whole, non-negative, bounded; floats are refused, never rounded), `email()` (trimmed, lowercased, 254 max), `url(schemes = ["http","https"])` (no credentials, no `javascript:`/`data:`), `tags()` (0 to 10 tags of 1 to 30 characters, case-insensitive de-duplication), `choice([...])`.
- **`parseBody(schema, request)`** reads the size-capped body and validates it: malformed JSON is 400, schema failures are 422 with `fieldErrors` keyed by path (`"tags.1"`). Use `z.strictObject` for write schemas so unknown fields (for example a client-sent `organization_id`) are errors.
- **`listQuery({ sortable, defaultSort, defaultOrder?, filters? })`** builds a list endpoint's query schema: `page` (>= 1, default 1), `limit` (default 25), `sort` (enum of the whitelist), `order` (`asc`/`desc`, default `desc`) plus the endpoint's own filters. `parseQuery(schema, searchParams)` validates it; empty values count as absent, unknown and repeated parameters are 422. **`limit` above 100 is rejected with 422, not clamped**, so a client always knows what it received.
- **Sort is never SQL text.** `sort` can only be a whitelisted key; map it to a column with a constant record at the call site.
- `paginate({ page, limit }, total)` returns `{ offset, from, to, meta }`; `meta` is `{ page, limit, total, totalPages }` (`totalPages` is 0 for an empty collection). Pass `from`/`to` to Supabase `.range()`.

## Choosing the organization: `X-Organization-Id` (SIT-193)

Every tenant endpoint takes the workspace in the **`X-Organization-Id` request header** (a UUID), not in the path. The PRD's endpoint inventory is unprefixed (`/api/v1/customers`), and a header keeps one URL per resource. Use `withOrgApi` for such routes; it hands the handler a verified, typed context.

```ts
// src/app/api/v1/things/route.ts
export const GET = withOrgApi(async ({ org, supabase }) => {
  // org.org.id, org.role, org.kind, org.expired; supabase acts as the caller, RLS applies
  return okList(await listThings(supabase, org.org.id));
});
```

| Situation                                                      | Result                                                                                                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header names an organization the caller belongs to             | that organization; `role` and `kind` come from the database                                                                                                           |
| Header names another tenant's id, or an id that does not exist | **404** `ORG_NOT_FOUND`, the same message for both, so existence never leaks                                                                                          |
| Header is not a UUID                                           | 400 `BAD_REQUEST` (no database read)                                                                                                                                  |
| No header, exactly one membership                              | that organization                                                                                                                                                     |
| No header, several memberships                                 | **422** `ORG_SELECTION_REQUIRED` (no silent default)                                                                                                                  |
| No header, no membership                                       | 404 `NO_WORKSPACE`                                                                                                                                                    |
| Demo workspace past `expires_at`                               | **403** `DEMO_EXPIRED` (a distinct code); `withOrgApi(..., { allowExpired: true })` lets a route such as the session endpoint still answer, with `org.expired = true` |

- The id is a **selector, never an authorization**. Each request re-proves membership with a read of the caller's own memberships under their session (RLS applies, never the admin client), and the role is taken from that row. A user id or role sent by a client is ignored. An id kept in a cookie or local storage is only a UI preference that is sent as this header and re-verified every time.
- `resolveOrg(request, user, supabase)` and the pure `selectOrg(user, memberships, header)` are in `src/lib/api/org-context.ts`.

## Implemented endpoints (SIT-203)

Full machine-readable contract: `docs/openapi.yaml` (a test fails when a route and the file disagree).

| Method and path                 | Purpose                                                                                                                                                                                                         | Success | Notable errors                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `GET /api/v1/session`           | The caller: `user` (id, display name, `isAnonymous`, email for members only), `organizations` (id, name, `kind`, role, timezone, `expiresAt`, `secondsRemaining`, `expired`) and `demo` (a guest's demo expiry) | 200     | 401                                                                                                |
| `GET /api/v1/organizations`     | The caller's workspaces only (RLS), `meta.total`                                                                                                                                                                | 200     | 401                                                                                                |
| `POST /api/v1/organizations`    | Create a real workspace through `create_real_organization`; body `{ name, industry?, timezone? }`, unknown fields rejected                                                                                      | 201     | 401, 403 `ACCOUNT_REQUIRED` (guest) or `ORIGIN_FORBIDDEN`, 422 with `fieldErrors`, 429 `ORG_LIMIT` |
| `GET /api/v1/organizations/:id` | One workspace the caller belongs to, with their role; an expired demo is still readable (`expired: true`)                                                                                                       | 200     | 400 (id not a UUID), 401, 404 (not a member and unknown ids look the same)                         |

`PATCH /api/v1/organizations/:id` updates the workspace's name, industry and time zone (owner or admin; body carries the `version` for the stale-edit check). It is in `docs/openapi.yaml`.

## Stale edits and retries (SIT-183)

**Stale edits** (`src/lib/api/concurrency.ts`). An update carries what the client last saw, and the `UPDATE` only matches that exact state. CRM entities use `updated_at`; entities that need a counter (quotes) use an integer `version`.

```ts
const body = updateCustomerSchema.parse(await request.json()); // { ...fields, ...expectedUpdatedAtField }
const row = await updateIfCurrent(supabase, {
  table: "customers",
  id,
  expected: { updatedAt: body.expectedUpdatedAt }, // or { version: body.expectedVersion }
  patch: fields,
});
```

- Zero rows and the record exists: `409 STALE_EDIT` with `error.meta.current = { updatedAt, version? }`. Zero rows and the caller cannot see it: `404` (the same as another tenant's record).
- Send `updatedAt` back exactly as the API returned it (a string with microseconds). Never round-trip it through `new Date()`.
- Check the caller's role first; RLS still applies, but `updateIfCurrent` does not decide authorization.
- A version table adds `version integer not null default 1` and `before update ... execute function private.bump_version()`; the client cannot set it. An `updated_at` table uses `private.set_updated_at()`.

**Idempotency** (`src/lib/api/idempotency.ts`). For requests whose side effects must not repeat (demo bootstrap and reset, quote creation, import commits):

```ts
const key = readIdempotencyKey(request); // Idempotency-Key header; null when absent; malformed is 422
return withIdempotency(supabase, { route: "POST /api/v1/quotes", key, payload: body }, async () =>
  created(await createQuote(body)),
);
```

- Scope: signed-in user + route + key; bound to the payload (same key, different payload: `422 IDEMPOTENCY_KEY_REUSED`). A duplicate while the first is running: `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After: 2`. A replay returns the stored status and body and does not run the work.
- If the work throws, the key is released so the client can retry with the same key. A claim abandoned by a crashed request is retaken after 2 minutes. Results are kept for 24 hours; `public.cleanup_purge_expired_keys` (the demo cleanup job) deletes expired keys.
- Key format: 8 to 128 characters of letters, digits, `-` and `_`. Stored results are capped at 100 KB.
- The store `private.idempotency_keys` has no client grants and no RLS policy; only `idempotency_begin / complete / abandon` (SECURITY DEFINER, acting as `auth.uid()`) reach it. A signed-out caller (public bootstrap) gets no replay protection from this store; use the CAPTCHA and the database's own idempotence there.
- Client: `src/lib/api-client/idempotency.ts` has `newIdempotencyKey()` and `createSingleFlight()`: a second submit while one is pending is ignored, and a retry after a failure reuses the key; a success clears it.

## Using the API from the browser (SIT-184)

One client data system: TanStack Query, through `src/lib/api-client/`. Server Components do the first secured read (RLS applies, nothing waits on the client); the client cache takes over for interactive reads and every mutation.

- **`apiFetch(path, options)`** returns `{ data, meta }` and throws `ClientApiError` (`status`, `code`, `message`, `requestId`, `fieldErrors`, `meta`, `retryAfterSeconds`; helpers `isStaleEdit`, `isValidation`, `isUnauthenticated`, `isTransient`). A network failure is `NETWORK_ERROR` (status 0), an unreadable body `INVALID_RESPONSE`; an abort is re-thrown as is. Only same-origin `/api/v1` paths are accepted; `query` drops empty values. It sends `X-Organization-Id` and `Idempotency-Key` when given.
- **`<ApiClientProvider key=... organizationId=...>`** wraps `/app` (in `src/app/app/layout.tsx`). The key is `userId:organizationId`, so switching workspace or user remounts it with a new, empty cache. Signing out clears it explicitly (`useClearApiCache`, called by the user menu's sign-out form) and leaving `/app` unmounts it. Defaults: fresh 30 s, kept 5 min, no retry of 4xx, at most two retries of transient failures, no mutation retries.
- **`useApiQuery(key, path, { query, initialData })`** scopes the key to the workspace (`[organizationId, ...key]`). **`useApi()`** gives `fetch` already carrying the workspace header.
- **`useApiMutation({ mutationFn, idempotent, optimistic, invalidate })`**: a second call while one is pending returns the same promise (one request); `idempotent` sends one key per intent, reused when the same intent is retried after a failure and dropped on success; `optimistic: { key, update }` updates the cached `data` at once and puts the old value back on any error; `invalidate` refetches the listed queries when the write settles.
- **URL state** (`url-state.ts`, `use-url-state.ts`): `defineUrlState({ q: urlField.string(), page: urlField.int(1), sort: urlField.enum([...], "name"), stage: urlField.list([...]) })`, then `const [state, set] = useUrlState(schema)`. Defaults are omitted, invalid values fall back to defaults, equal states give equal URLs, any change but `page` returns to page 1 (filters replace the history entry, pages push one). `useDebouncedUrlParam(state.q, (q) => set({ q }))` debounces the search box (300 ms). `defineUrlState` throws for sensitive-looking names (token, secret, password, session, key, email, phone, ...).
- **Free text is rendered as text.** ESLint bans `dangerouslySetInnerHTML` (JSX prop and props object) everywhere.
