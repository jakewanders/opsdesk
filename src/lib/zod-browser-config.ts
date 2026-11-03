import { z } from "zod";

/**
 * Zod 4 compiles faster validators with `new Function` when the page allows it, and probes for that by trying. The site's
 * Content-Security-Policy forbids eval (SIT-272), so the probe is reported to the browser as a violation on every page that validates
 * a form, even though Zod falls back correctly. Turning the compiled mode off makes the browser's violation report mean something:
 * any report is now a real problem. Validation results are identical; the difference is milliseconds on a form.
 */
z.config({ jitless: true });
