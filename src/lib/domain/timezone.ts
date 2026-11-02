/**
 * Same rule as the database (`private.is_valid_timezone`): `UTC` or an IANA `Area/City` name, no posix/right aliases.
 * One definition for organization settings and for the date logic that depends on a zone.
 */
export function isIanaTimeZone(value: string): boolean {
  if (value === "UTC") return true;
  if (!value.includes("/") || /^(posix|right)\//.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
