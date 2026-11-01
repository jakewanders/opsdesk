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
