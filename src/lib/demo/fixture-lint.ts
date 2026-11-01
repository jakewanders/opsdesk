/**
 * Fiction rules for demo fixtures (PRD 8.2). `lintFixtureText` returns a list of violations found in text
 * (SQL seeders, TypeScript fixtures): any email not at example.com, any phone outside the reserved
 * 555-0100..0199 block, and well-known real brand names. Used by the fixture lint test over every seed file.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const PHONE = /(?<![\d.])(?:\+?1[ .-]?)?\(?(\d{3})\)?[ .-]?(\d{3})[ .-](\d{4})(?![\d])/g;
const REAL_BRANDS =
  /\b(google|gmail|yahoo|hotmail|outlook|apple|amazon|microsoft|facebook|meta platforms|walmart|netflix|tesla|nike|disney|salesforce|hubspot|stripe|paypal)\b/i;

export function lintFixtureText(text: string): string[] {
  const problems: string[] = [];
  for (const match of text.matchAll(EMAIL)) {
    if (match[1].toLowerCase() !== "example.com")
      problems.push(`email not at example.com: ${match[0]}`);
  }
  for (const match of text.matchAll(PHONE)) {
    const [whole, , exchange, line] = match;
    if (exchange !== "555" || !/^01\d\d$/.test(line))
      problems.push(`phone outside 555-01xx: ${whole.trim()}`);
  }
  const brand = REAL_BRANDS.exec(text);
  if (brand) problems.push(`real brand name: ${brand[0]}`);
  return problems;
}
