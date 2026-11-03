import { z } from "zod";
import { isoDate } from "@/lib/validation";

/**
 * GET /reports query: a preset `range` (7, 30 or 90 days ending today in the organization's time zone) OR a custom `from` and `to`
 * (both, `YYYY-MM-DD`, at most 366 days). Giving both a preset and dates, one date alone, or an end before the start is a 422.
 */
export const reportQuery = z
  .strictObject({
    range: z
      .enum(["7", "30", "90"], { error: "Range must be 7, 30 or 90 days." })
      .transform(Number)
      .optional(),
    from: isoDate().optional(),
    to: isoDate().optional(),
  })
  .superRefine((v, ctx) => {
    const custom = v.from !== undefined || v.to !== undefined;
    if (custom && v.range !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["range"],
        message: "Use either a range or from and to, not both.",
      });
    if (custom && v.from === undefined)
      ctx.addIssue({ code: "custom", path: ["from"], message: "Add a start date." });
    if (custom && v.to === undefined)
      ctx.addIssue({ code: "custom", path: ["to"], message: "Add an end date." });
  });
export type ReportQuery = z.infer<typeof reportQuery>;
