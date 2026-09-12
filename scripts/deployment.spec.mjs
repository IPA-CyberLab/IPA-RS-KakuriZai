import fs from "node:fs/promises";
import { expect, test } from "@playwright/test";

const studioUrl = new URL(requiredEnvironment("STUDIO_URL"));
const worldName = process.env.KAKURIZAI_E2E_WORLD || "kakurizai-sandbox";
const expectedSubject = process.env.KAKURIZAI_E2E_SUBJECT || "";
const proxyServer = process.env.KAKURIZAI_E2E_PROXY || "";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the deployment E2E`);
  return value;
}

test("Keycloak-authenticated user runs hello world in VS Code Web", async ({ browser }, testInfo) => {
  await verifyKeycloakGitHubLoginRoute(browser);

  const context = await authenticatedContext(browser);
  const page = await context.newPage();
  const sessionResponse = await context.request.get(new URL("api/session", studioUrl).toString());
  const sessionBody = await sessionResponse.text();
  expect(sessionResponse.status(), sessionBody).toBe(200);
  const session = JSON.parse(sessionBody);
  expect(session.user?.provider).toBe("keycloak");
  expect(session.user?.subject).toBeTruthy();
  if (expectedSubject) expect(session.user.subject).toBe(expectedSubject);

  await page.goto(studioUrl.toString(), { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("KakuriZai Console")).toBeVisible();
  const sandboxRow = page.locator(".sandboxItem").filter({ hasText: worldName }).first();
  await expect(sandboxRow).toBeVisible();
  await sandboxRow.click();
  await expect(page.locator(".titleNameRow").filter({ hasText: worldName })).toBeVisible();

  const popupPromise = context.waitForEvent("page");
  const accessResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes("/dev-access/open")
  ), { timeout: 15 * 60 * 1000 });
  await page.getByRole("button", { name: /VS Code Web/ }).click();
  const popup = await popupPromise;
  const accessResponse = await accessResponsePromise;
  const accessBody = await accessResponse.text();
  expect(accessResponse.status(), accessBody).toBe(200);
  const access = JSON.parse(accessBody);
  expect(access.vscodeUrl).toBeTruthy();

  await popup.waitForURL((url) => url.origin === new URL(access.vscodeUrl).origin, {
    timeout: 3 * 60 * 1000,
    waitUntil: "domcontentloaded"
  });
  await expect(popup.locator(".monaco-workbench")).toBeVisible({ timeout: 5 * 60 * 1000 });
  await acceptWorkspaceTrustIfShown(popup);
  await createTerminal(popup);

  const terminalInput = popup.locator(".xterm-helper-textarea").last();
  await expect(terminalInput).toBeVisible();
  await terminalInput.click();
  const outputFile = `hello-world-output-${Date.now()}.txt`;
  const command = [
    "printf '%s\\n' '#!/bin/sh' 'printf \"\\150\\145\\154\\154\\157\\040\\167\\157\\162\\154\\144\\n\"' > /workspace/hello-world.sh",
    "chmod 755 /workspace/hello-world.sh",
    `/workspace/hello-world.sh | tee /workspace/${outputFile}`
  ].join(" && ");
  await popup.keyboard.insertText(command);
  await popup.keyboard.press("Enter");

  const outputFileEntry = popup.getByText(outputFile, { exact: true }).first();
  await expect(outputFileEntry).toBeVisible({ timeout: 2 * 60 * 1000 });
  await outputFileEntry.click();
  await expect(popup.locator(".view-lines").filter({ hasText: "hello world" }).first()).toBeVisible();
  await popup.screenshot({ path: testInfo.outputPath("vscode-hello-world.png"), fullPage: true });
  await context.close();
});

async function verifyKeycloakGitHubLoginRoute(browser) {
  const context = await browser.newContext(contextOptions());
  const page = await context.newPage();
  const visited = [];
  page.on("request", (request) => visited.push(request.url()));

  await page.goto(studioUrl.toString(), { waitUntil: "domcontentloaded" });
  const signIn = page.getByRole("button", { name: /Sign in with Keycloak/i });
  await expect(signIn).toBeVisible();
  await signIn.click();
  await expect.poll(() => visited.some((url) => (
    url.includes("/realms/kakurizai/protocol/openid-connect/auth")
  )), { message: "Studio should redirect through the KakuriZai Keycloak realm" }).toBe(true);

  const githubChoice = page.getByRole("link", { name: /GitHub/i });
  if (await githubChoice.isVisible().catch(() => false)) await githubChoice.click();
  await expect.poll(() => visited.some((url) => new URL(url).hostname === "github.com"), {
    timeout: 2 * 60 * 1000,
    message: "Keycloak should expose GitHub as the login route"
  }).toBe(true);
  await context.close();
}

async function authenticatedContext(browser) {
  const storageState = process.env.KAKURIZAI_E2E_STORAGE_STATE;
  if (storageState) return browser.newContext(contextOptions({ storageState }));

  const sessionId = process.env.KAKURIZAI_E2E_SESSION_ID || await sessionIdFromFile(
    process.env.KAKURIZAI_E2E_SESSION_FILE
  );
  if (!sessionId) {
    throw new Error(
      "Set KAKURIZAI_E2E_STORAGE_STATE, KAKURIZAI_E2E_SESSION_ID, or KAKURIZAI_E2E_SESSION_FILE to a live Keycloak-authenticated session"
    );
  }
  const context = await browser.newContext(contextOptions());
  await context.addCookies([{
    name: "kakurizai_session",
    value: sessionId,
    domain: studioUrl.hostname,
    path: "/",
    httpOnly: true,
    secure: studioUrl.protocol === "https:",
    sameSite: "Strict"
  }]);
  return context;
}

function contextOptions(extra = {}) {
  return {
    ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
    ...extra
  };
}

async function sessionIdFromFile(file) {
  if (!file) return "";
  const stored = JSON.parse(await fs.readFile(file, "utf8"));
  const sessions = Array.isArray(stored) ? stored : stored.sessions;
  return sessions?.find((session) => Number(session.expiresAt || 0) > Date.now())?.id || "";
}

async function acceptWorkspaceTrustIfShown(page) {
  const trust = page.getByRole("button", { name: /Yes, I trust the authors/i });
  if (await trust.isVisible({ timeout: 5000 }).catch(() => false)) await trust.click();
}

async function createTerminal(page) {
  await page.keyboard.press("Control+Shift+P");
  const commandInput = page.locator(".quick-input-widget input");
  await expect(commandInput).toBeVisible();
  await commandInput.fill(">Terminal: Create New Terminal");
  await expect(page.locator(".quick-input-list").getByText(/Terminal: Create New Terminal/, { exact: false }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator(".terminal-wrapper .xterm").last()).toBeVisible({ timeout: 2 * 60 * 1000 });
}
