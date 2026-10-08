import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/** The "Yearly growth" figure once the worker has answered. */
async function yearlyGrowth(page: Page): Promise<string> {
  const value = page.locator("dt", { hasText: "Yearly growth" }).locator("xpath=following-sibling::dd");
  await expect(value).not.toHaveText("…", { timeout: 30_000 });
  return (await value.textContent())!;
}

test("the backtest runs in the browser and reruns when a slider moves", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("rerun five years");
  const before = await yearlyGrowth(page);
  expect(before).toMatch(/^[+−]\d+\.\d%$/);
  await expect(page.getByText(/Simulated [\d,]+ days in \d+ ms/)).toBeVisible();

  const horizon = page.getByRole("slider", { name: /Trend horizon/ });
  await horizon.focus();
  await horizon.press("ArrowRight");
  await expect(page).toHaveURL(/[?&]h=1\.25/);
  await expect(page.getByText("Looks back 18, 35, 70, 140 days")).toBeVisible();
  await expect.poll(() => yearlyGrowth(page)).not.toBe(before);
});

test("a shared link restores the configuration", async ({ page }) => {
  await page.goto("/?from=2024&coins=BTC,ETH&shorts=1#lab");
  await expect(page.getByRole("combobox", { name: "Start" })).toHaveValue("2024");
  await expect(page.getByRole("button", { name: "BTC", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "SOL", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("checkbox", { name: "Allow short positions" })).toBeChecked();
  await yearlyGrowth(page);

  await page.getByRole("button", { name: "Reset to defaults" }).click();
  await expect(page).not.toHaveURL(/from=/);
});

test("the execution replay plays a scenario to its outcome", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); // jump to the last frame
  await page.goto("/#execution");
  await page.getByRole("radio", { name: /Patient fill/ }).click();
  await expect(page.getByText("Done: 100% filled at maker fee (0.015%)")).toBeVisible();
  await page.getByRole("radio", { name: /Close rejected/ }).click();
  await expect(page.getByText(/CloseFailedError/)).toBeVisible();
});

test("no serious accessibility violations", async ({ page }) => {
  await page.goto("/");
  await yearlyGrowth(page); // scan the page with results rendered
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target.join(" ")}`)).toEqual([]);
});
