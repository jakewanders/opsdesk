/**
 * The API's query schemas read strings (they parse URLs), so a typed query (numbers, optional values) is written the way a
 * URL would carry it: values that are `undefined` are left out, the rest become text.
 */
export function stringifyQuery(
  query: Record<string, string | number | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}
