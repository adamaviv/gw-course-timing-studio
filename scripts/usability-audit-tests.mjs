#!/usr/bin/env node

process.env.NO_SERVER = '1';
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

import net from 'node:net';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('FAIL Could not load Playwright. Install dev dependencies and browser binaries first.');
  console.log('  - npm install');
  console.log('  - npx playwright install chromium');
  process.exitCode = 1;
  process.exit();
}

const { startServer } = await import('../server/index.js');

const AUDIT_CONFIG = {
  baseUrl: process.env.USABILITY_BASE_URL || null,
  campusId: String(process.env.USABILITY_CAMPUS_ID || '1'),
  termId: String(process.env.USABILITY_TERM_ID || '202601'),
  subjectId: String(process.env.USABILITY_SUBJECT_ID || 'CSCI').toUpperCase(),
  screenshotPath: process.env.USABILITY_SCREENSHOT_PATH || '/tmp/usability-audit-failure.png',
};
const RECENT_SUBJECTS_STORAGE_KEY = 'gw-course-studio-recent-subjects-v1';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('Could not reserve a local port for usability test.')));
        return;
      }
      const { port } = address;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    probe.on('error', reject);
  });
}

async function waitForServerReady(baseUrl, timeoutMs = 45000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/`, { method: 'GET' });
      if (response.ok) {
        return;
      }
    } catch {
      // retry until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Server at ${baseUrl} did not become ready within ${timeoutMs}ms.`);
}

async function runStep(step, context, failures) {
  try {
    await step.run(context);
    console.log(`PASS ${step.description}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${step.description}`);
    console.log(`  - ${message}`);
    failures.push({ step: step.description, message });
  }
}

async function assertStorageRecoveryScenario({ browser, baseUrl, initScript }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  try {
    if (initScript) {
      await page.addInitScript(initScript, RECENT_SUBJECTS_STORAGE_KEY);
    }
    const response = await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    assert(response && response.ok(), `Expected HTTP 200 from home page, got ${response?.status?.() ?? 'unknown'}.`);

    const errorBox = page.locator('.error-box');
    await errorBox.waitFor({ timeout: 15000 });

    const recoveryButton = page.getByRole('button', { name: 'Clear Local Storage' });
    await recoveryButton.waitFor({ timeout: 10000 });

    const storageValueBeforeClear = await page.evaluate((storageKey) => window.localStorage.getItem(storageKey), RECENT_SUBJECTS_STORAGE_KEY);
    await recoveryButton.click();
    await errorBox.waitFor({ state: 'hidden', timeout: 10000 });

    const storageValueAfterClear = await page.evaluate((storageKey) => window.localStorage.getItem(storageKey), RECENT_SUBJECTS_STORAGE_KEY);
    const isClearedState = storageValueAfterClear == null || storageValueAfterClear === '[]';
    assert(
      isClearedState,
      `Expected local storage to be cleared/reset after recovery. before=${String(storageValueBeforeClear)} after=${String(storageValueAfterClear)}`
    );
  } finally {
    await context.close();
  }
}

const STEPS = [
  {
    description: 'Storage recovery button appears for mangled or out-of-sync local storage and clears state',
    run: async ({ browser, baseUrl }) => {
      await assertStorageRecoveryScenario({
        browser,
        baseUrl,
        initScript: (storageKey) => {
          window.localStorage.removeItem(storageKey);
          window.localStorage.setItem(storageKey, '{corrupted-json');
        },
      });

      await assertStorageRecoveryScenario({
        browser,
        baseUrl,
        initScript: (storageKey) => {
          window.localStorage.setItem(storageKey, '[]');
          const originalSetItem = window.Storage.prototype.setItem;
          let failedOnce = false;
          Object.defineProperty(window.Storage.prototype, 'setItem', {
            configurable: true,
            value: function setItemWithFailure(key, value) {
              if (String(key) === storageKey && !failedOnce) {
                failedOnce = true;
                throw new Error('Simulated localStorage out-of-sync/write failure');
              }
              return originalSetItem.call(this, key, value);
            },
          });
        },
      });
    },
  },
  {
    description: 'Home page renders title and initial controls',
    run: async ({ page }) => {
      const response = await page.goto(page.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      assert(response && response.ok(), `Expected HTTP 200 from home page, got ${response?.status?.() ?? 'unknown'}.`);

      await page.getByRole('heading', { name: 'GW Course Studio' }).waitFor({ timeout: 15000 });
      await page.getByRole('button', { name: /Load Classes|Add Subject/i }).waitFor({ timeout: 10000 });
    },
  },
  {
    description: 'Term/campus/subject selectors accept configured values',
    run: async ({ page }) => {
      await page.selectOption('#term-id', AUDIT_CONFIG.termId);
      await page.selectOption('#campus-id', AUDIT_CONFIG.campusId);
      await page.locator('#subject-id').fill(AUDIT_CONFIG.subjectId);

      const termValue = await page.locator('#term-id').inputValue();
      const campusValue = await page.locator('#campus-id').inputValue();
      const subjectValue = await page.locator('#subject-id').inputValue();

      assert(termValue === AUDIT_CONFIG.termId, `Expected termId ${AUDIT_CONFIG.termId}, got ${termValue}.`);
      assert(campusValue === AUDIT_CONFIG.campusId, `Expected campusId ${AUDIT_CONFIG.campusId}, got ${campusValue}.`);
      assert(subjectValue === AUDIT_CONFIG.subjectId, `Expected subjectId ${AUDIT_CONFIG.subjectId}, got ${subjectValue}.`);
    },
  },
  {
    description: 'Load Classes fetch succeeds and workspace appears',
    run: async ({ page }) => {
      const parseRequest = page.waitForResponse(
        (response) => response.url().includes('/api/parse-url') && response.request().method() === 'POST',
        { timeout: 120000 }
      );

      await page.getByRole('button', { name: /Load Classes|Add Subject/i }).click();
      const response = await parseRequest;
      assert(response.ok(), `Expected /api/parse-url to return HTTP 200, got ${response.status()}.`);

      await page.locator('.workspace').waitFor({ timeout: 60000 });
    },
  },
  {
    description: 'Course list can be made visible for interaction',
    run: async ({ page }) => {
      const collapsedInitially = (await page.locator('.course-item').count()) === 0;
      if (collapsedInitially) {
        const searchInput = page.getByPlaceholder('Filter course number, title, instructor...');
        await searchInput.fill(AUDIT_CONFIG.subjectId);
      }

      await page.locator('.course-item').first().waitFor({ timeout: 20000 });
      const rows = await page.locator('.course-item').count();
      assert(rows > 0, 'Expected at least one visible course row after expansion path.');
    },
  },
  {
    description: 'Selecting a class updates selected panel and calendar',
    run: async ({ page }) => {
      const firstSelectable = page.locator('.course-item input[type="checkbox"]:not([disabled])').first();
      await firstSelectable.waitFor({ timeout: 10000 });
      await firstSelectable.check();

      const selectedCountText = (await page.locator('.selected-frame .subject-frame-count').first().textContent()) || '';
      assert(/\b[1-9]\d*\s+selected\b/i.test(selectedCountText), `Expected selected count to increase, got "${selectedCountText.trim()}".`);

      const eventCount = await page.locator('.event').count();
      assert(eventCount > 0, 'Expected at least one calendar event after selecting a class.');
    },
  },
  {
    description: 'Calendar event opens and closes details modal',
    run: async ({ page }) => {
      await page.locator('.event').first().click();
      const dialog = page.getByRole('dialog', { name: 'Course details' });
      await dialog.waitFor({ timeout: 10000 });
      await page.getByRole('button', { name: 'Close details' }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 10000 });
    },
  },
  {
    description: 'Day focus toggle and week reset work',
    run: async ({ page }) => {
      await page.getByRole('button', { name: 'Mon' }).first().click();
      await page.getByRole('button', { name: 'Week View' }).waitFor({ timeout: 10000 });
      await page.getByRole('button', { name: 'Week View' }).click();
    },
  },
  {
    description: 'Removing loaded subject returns to empty state',
    run: async ({ page }) => {
      await page.getByRole('button', { name: 'Remove Subject' }).first().click();
      await page.locator('.workspace').waitFor({ state: 'hidden', timeout: 10000 });
    },
  },
];

async function run() {
  const failures = [];
  let browser;
  let page;

  try {
    let baseUrl = AUDIT_CONFIG.baseUrl;

    if (!baseUrl) {
      const port = await reservePort();
      process.env.PORT = String(port);
      await startServer();
      baseUrl = `http://127.0.0.1:${port}`;
      await waitForServerReady(baseUrl);
    }

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    page.baseUrl = baseUrl;

    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (error) => {
      consoleErrors.push(`pageerror: ${error.message}`);
    });

    for (const step of STEPS) {
      await runStep(step, { page, browser, baseUrl }, failures);
      if (failures.length > 0) {
        break;
      }
    }

    if (consoleErrors.length > 0) {
      console.log('FAIL Browser console emitted errors');
      for (const error of consoleErrors) {
        console.log(`  - ${error}`);
      }
      failures.push({ step: 'Console errors', message: consoleErrors.join(' | ') });
    }
  } finally {
    if (failures.length > 0 && page) {
      try {
        await page.screenshot({ path: AUDIT_CONFIG.screenshotPath, fullPage: true });
        console.log(`INFO Saved failure screenshot: ${AUDIT_CONFIG.screenshotPath}`);
      } catch {
        // best effort only
      }
    }

    if (browser) {
      await browser.close();
    }
  }

  if (failures.length > 0) {
    process.exit(1);
  }

  console.log('PASS Usability audit completed successfully.');
  process.exit(0);
}

await run();
