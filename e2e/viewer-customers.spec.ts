import { expect, test } from "@playwright/test";
import {
  addMember,
  api,
  cleanUp,
  makeUser,
  makeWorkspace,
  signIn,
  type Person,
} from "./support/local";

/** [SIT-251] A viewer can read customers but every write control is absent or disabled, and a direct API write is a 403. */
let owner: Person, viewer: Person;
let org = "";
let customerId = "";
const NAME = "Viewer Visible Co";

test.beforeAll(async () => {
  [owner, viewer] = await Promise.all([makeUser("owner"), makeUser("viewer")]);
  org = await makeWorkspace(owner, "E2E Viewer Co");
  addMember(org, viewer, "viewer");
  const res = await api(owner, "POST", "/customers", org, {
    displayName: NAME,
    email: "v@example.com",
  });
  customerId = ((await res.json()) as { data: { id: string } }).data.id;
});
test.afterAll(cleanUp);

test("a viewer sees the customer but has no way to change it", async ({ page, context }) => {
  await signIn(context, viewer);
  await page.goto("/app/customers");
  await expect(page.getByRole("link", { name: NAME })).toBeVisible();
  await expect(page.getByRole("link", { name: /Add customer/ })).toHaveCount(0);

  await page.getByRole("button", { name: `Actions for ${NAME}` }).click();
  await expect(
    page.getByRole("menuitem", { name: /Archive \(needs edit access\)/ }),
  ).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("menuitem", { name: "Edit", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto(`/app/customers/${customerId}`);
  await expect(page.getByRole("heading", { name: new RegExp(NAME) })).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Archive" })).toBeDisabled();
  await expect(page.getByText("You can view this customer but not archive it")).toBeVisible();

  await page.goto("/app/customers/new");
  await expect(page.getByText(/You can view customers but not add them/)).toBeVisible();
  await expect(page.getByRole("form")).toHaveCount(0);
});

test("direct API writes as the viewer are refused with 403 and change nothing", async () => {
  const create = await api(viewer, "POST", "/customers", org, { displayName: "Sneaky" });
  expect(create.status).toBe(403);
  const archive = await api(viewer, "DELETE", `/customers/${customerId}`, org);
  expect(archive.status).toBe(403);
  const read = await api(viewer, "GET", `/customers/${customerId}`, org);
  expect(
    ((await read.json()) as { data: { archivedAt: string | null } }).data.archivedAt,
  ).toBeNull();
});
