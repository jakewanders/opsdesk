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

`code` is for programs, `message` is written for the user, `fieldErrors` (optional) maps field names (dotted for nesting, `_form` for form-level) to messages, `requestId` matches the `X-Request-Id` response header.

| HTTP | `code`                                                                                                                                   | Meaning                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 400  | `BAD_REQUEST`                                                                                                                            | malformed request: invalid JSON, a bad id format                                                             |
| 401  | `UNAUTHENTICATED`                                                                                                                        | no valid session                                                                                             |
| 403  | `FORBIDDEN`                                                                                                                              | signed in, but role or workspace may not do this                                                             |
| 404  | `NOT_FOUND`                                                                                                                              | record missing **or in another tenant** (never distinguished)                                                |
| 409  | `CONFLICT`, `DUPLICATE`                                                                                                                  | stale edit, or a unique violation                                                                            |
| 413  | `PAYLOAD_TOO_LARGE`                                                                                                                      | JSON body over the cap (enforced by SIT-181)                                                                 |
| 415  | `UNSUPPORTED_MEDIA_TYPE`                                                                                                                 | a body that is not `application/json` (an addition to the PRD list; see `docs/DECISIONS.md`)                 |
| 422  | `VALIDATION_ERROR`, `INVALID_REFERENCE`, `CHECK_VIOLATION`, `REQUIRED_VALUE`, `VALUE_TOO_LONG`, `VALUE_OUT_OF_RANGE`, or a business code | well-formed but invalid, or a rule refuses it                                                                |
| 429  | `RATE_LIMITED` or a business code (for example `DEMO_QUOTA`)                                                                             | quota or throttle; `Retry-After` header when known                                                           |
| 500  | `INTERNAL_ERROR`                                                                                                                         | anything unexpected. Always the same generic message; the cause is logged server-side against the request ID |

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
