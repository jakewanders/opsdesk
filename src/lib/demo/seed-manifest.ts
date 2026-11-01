/**
 * Target contents of a freshly seeded demo workspace (PRD 8.2). Entity issues register a seeder that
 * produces their count; the verification issue (SIT-258) asserts these numbers against the database.
 * Seeded activity events have no actor (`System`).
 */
export const DEMO_SEED_MANIFEST = {
  customers: 18,
  opportunities: 10,
  tasks: 24,
  /** Only when the quotes feature flag is on (M4). */
  quotes: 4,
  /** About this many; entity seeders log their own creation events. */
  activityEvents: 40,
  /** Seeded dates spread over this many days before today. */
  historyDays: 90,
} as const;

export type DemoSeedManifest = typeof DEMO_SEED_MANIFEST;
