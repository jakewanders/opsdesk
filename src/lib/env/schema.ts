import { z } from "zod";

/** Production origin (PRD 10.2). Netlify sets CONTEXT=production on production deploys. */
export const PRODUCTION_ORIGIN = "https://opsdesk.sitelaunch.dev";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

/** Optional string: an empty value (as in a copied .env.example) counts as unset. */
const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());

const requiredString = (name: string) =>
  z.preprocess(
    emptyToUndefined,
    z.string({ error: `${name} is required` }).min(1, `${name} is required`),
  );

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const urlString = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(1, `${name} is required`)
    .refine(isHttpUrl, { error: `${name} must be a valid URL starting with http:// or https://` });

const httpUrl = (name: string) => z.preprocess(emptyToUndefined, urlString(name));

/** Accepts true/false/1/0/yes/no/on/off (any case). Empty or unset uses the default. */
export function booleanFlag(name: string, defaultValue: boolean) {
  return z.preprocess(
    (value) => {
      const v = emptyToUndefined(value);
      if (v === undefined) return defaultValue;
      if (typeof v === "boolean") return v;
      if (typeof v !== "string") return v;
      const s = v.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(s)) return true;
      if (["false", "0", "no", "off"].includes(s)) return false;
      return v;
    },
    z.boolean({ error: `${name} must be true or false` }),
  );
}

export const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: httpUrl("NEXT_PUBLIC_SUPABASE_URL"),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: requiredString("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
  NEXT_PUBLIC_APP_URL: z.preprocess(
    (value) => emptyToUndefined(value) ?? "http://localhost:3000",
    urlString("NEXT_PUBLIC_APP_URL"),
  ),
  NEXT_PUBLIC_GITHUB_REPO_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: optionalString,
  NEXT_PUBLIC_ENABLE_QUOTES: booleanFlag("NEXT_PUBLIC_ENABLE_QUOTES", true),
  NEXT_PUBLIC_ENABLE_CSV_IMPORT: booleanFlag("NEXT_PUBLIC_ENABLE_CSV_IMPORT", true),
  NEXT_PUBLIC_ENABLE_BILLING: booleanFlag("NEXT_PUBLIC_ENABLE_BILLING", false),
  NEXT_PUBLIC_ENABLE_EMAIL: booleanFlag("NEXT_PUBLIC_ENABLE_EMAIL", false),
  NEXT_PUBLIC_ENABLE_AI: booleanFlag("NEXT_PUBLIC_ENABLE_AI", false),
  NEXT_PUBLIC_ENABLE_INTEGRATIONS: booleanFlag("NEXT_PUBLIC_ENABLE_INTEGRATIONS", false),
});

export const serverEnvSchema = z.object({
  // Privileged: demo cleanup and guarded operations only, never basic CRUD.
  SUPABASE_SECRET_KEY: optionalString,
  TURNSTILE_SECRET_KEY: optionalString,
  // Optional P2 integrations (feature flags off by default).
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  RESEND_API_KEY: optionalString,
  AI_API_KEY: optionalString,
  // Provided by Netlify; "production" enforces the production origin below.
  CONTEXT: optionalString,
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type FeatureFlags = {
  quotes: boolean;
  csvImport: boolean;
  billing: boolean;
  email: boolean;
  ai: boolean;
  integrations: boolean;
};

export class EnvError extends Error {
  constructor(
    public readonly issues: string[],
    scope: string,
  ) {
    super(
      `Invalid ${scope} environment:\n${issues.map((i) => `  - ${i}`).join("\n")}\n` +
        "Copy .env.example to .env.local and fill in the missing values.",
    );
    this.name = "EnvError";
  }
}

function describe(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const key = issue.path.join(".");
    // Our messages already name the variable; add the key only when they do not.
    return issue.message.includes(key) || key === "" ? issue.message : `${key}: ${issue.message}`;
  });
}

type Source = Record<string, string | undefined>;

export function parsePublicEnv(source: Source, serverContext?: string): PublicEnv {
  const result = publicEnvSchema.safeParse(source);
  if (!result.success) throw new EnvError(describe(result.error), "public");
  const env = result.data;
  const problems: string[] = [];
  const url = new URL(env.NEXT_PUBLIC_APP_URL);
  if (!LOCAL_HOSTS.has(url.hostname) && url.protocol !== "https:") {
    problems.push("NEXT_PUBLIC_APP_URL must use https:// unless it is localhost");
  }
  if (serverContext === "production" && url.origin !== PRODUCTION_ORIGIN) {
    problems.push(`NEXT_PUBLIC_APP_URL must be ${PRODUCTION_ORIGIN} for production deploys`);
  }
  if (problems.length > 0) throw new EnvError(problems, "public");
  return env;
}

export function parseServerEnv(source: Source): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) throw new EnvError(describe(result.error), "server");
  return result.data;
}

export function toFeatureFlags(env: PublicEnv): FeatureFlags {
  return {
    quotes: env.NEXT_PUBLIC_ENABLE_QUOTES,
    csvImport: env.NEXT_PUBLIC_ENABLE_CSV_IMPORT,
    billing: env.NEXT_PUBLIC_ENABLE_BILLING,
    email: env.NEXT_PUBLIC_ENABLE_EMAIL,
    ai: env.NEXT_PUBLIC_ENABLE_AI,
    integrations: env.NEXT_PUBLIC_ENABLE_INTEGRATIONS,
  };
}
