import { NotFoundError } from "@/lib/api/errors";
import { withApi } from "@/lib/api/handler";

/**
 * Any `/api/v1/...` path that is not an endpoint (SIT-275): the standard error envelope with a request id, logged like every
 * other call, instead of the framework's bare 404 page. No session is read and no data is touched.
 */
const notFound = withApi<{ path: string[] }>(
  async () => {
    throw new NotFoundError("That endpoint does not exist.", "ENDPOINT_NOT_FOUND");
  },
  { auth: "none", skipOriginCheck: true },
);

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
