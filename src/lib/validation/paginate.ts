import type { ApiMeta } from "@/lib/api/types";

export type PageRequest = { page: number; limit: number };

/**
 * Pagination arithmetic for a list endpoint. `offset` feeds `.range(offset, offset + limit - 1)`;
 * `meta` is the `page/limit/total/totalPages` object `okList` returns. An empty collection has
 * `totalPages: 0`; a page past the end yields an empty list with the requested page echoed back.
 */
export function paginate({ page, limit }: PageRequest, total: number) {
  const safeTotal = Math.max(0, Math.trunc(total));
  const meta: ApiMeta = { page, limit, total: safeTotal, totalPages: Math.ceil(safeTotal / limit) };
  return { offset: (page - 1) * limit, from: (page - 1) * limit, to: page * limit - 1, meta };
}
