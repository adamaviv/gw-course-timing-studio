#!/usr/bin/env node

process.env.NO_SERVER = '1';
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

import net from 'node:net';
import lzString from 'lz-string';

const { compressToEncodedURIComponent } = lzString;

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
let lastSharedUrl = '';

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
    description: 'Advanced search DSL handles wildcard/comparator/OR queries without breaking list rendering',
    run: async ({ page }) => {
      const searchInput = page.getByPlaceholder('Filter course number, title, instructor...');
      await searchInput.waitFor({ timeout: 10000 });

      const queries = ['1*-4*', '62+', '<3*', '62* || 8*'];
      let sawAnyVisibleResult = false;

      for (const query of queries) {
        await searchInput.fill(query);
        await page.waitForTimeout(250);
        const inputValue = await searchInput.inputValue();
        assert(inputValue === query, `Expected search input to keep query "${query}", got "${inputValue}".`);

        const visibleRows = await page.locator('.course-item').count();
        if (visibleRows > 0) {
          sawAnyVisibleResult = true;
        }
      }

      assert(sawAnyVisibleResult, 'Expected at least one DSL query to produce visible course rows.');
      await searchInput.fill('');
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
    description: 'Share URL auto-sync updates location after selection',
    run: async ({ page }) => {
      await page.waitForFunction(
        () => {
          const params = new URLSearchParams(window.location.search);
          return params.get('share_v') === '1' && params.get('share_t') && params.get('share_sel');
        },
        { timeout: 10000 }
      );
      const searchText = await page.evaluate(() => window.location.search || '');
      assert(/share_v=1/.test(searchText), `Expected auto-synced share_v in URL, got "${searchText}".`);
      assert(/share_sel=/.test(searchText), `Expected auto-synced share_sel in URL, got "${searchText}".`);
    },
  },
  {
    description: 'Share button copies a readable query URL and restores state in a fresh tab',
    run: async ({ page, browser }) => {
      await page.getByLabel('Show only selected').check();
      await page.getByLabel('Show cancelled').check();
      await page.getByRole('button', { name: 'Mon' }).first().click();
      await page.getByRole('button', { name: 'Week View' }).waitFor({ timeout: 10000 });

      await page.waitForFunction(
        () => {
          const params = new URLSearchParams(window.location.search);
          return (
            params.get('share_only_sel') === '1' &&
            params.get('share_show_cancel') === '1' &&
            params.get('share_day') === 'M'
          );
        },
        { timeout: 10000 }
      );

      const shareButton = page.getByRole('button', { name: 'Copy share link' });
      await shareButton.waitFor({ timeout: 10000 });
      assert(!(await shareButton.isDisabled()), 'Expected Share button to be enabled after selecting a class.');

      await shareButton.click();
      await page.locator('.share-status-success').waitFor({ timeout: 10000 });
      const sharedUrl = await page.evaluate(() => window.__gwClipboardText || '');
      assert(sharedUrl.includes('share_v=1'), `Expected copied URL to include readable share params, got "${sharedUrl}".`);
      assert(!sharedUrl.includes('share_z='), `Expected readable (not compressed) URL by default, got "${sharedUrl}".`);
      assert(!sharedUrl.includes('%40'), `Expected simplified CRN-only share_sel encoding, got "${sharedUrl}".`);
      lastSharedUrl = sharedUrl;

      const restoredContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const restoredPage = await restoredContext.newPage();
      try {
        const restoredResponse = await restoredPage.goto(sharedUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        assert(
          restoredResponse && restoredResponse.ok(),
          `Expected HTTP 200 from shared URL, got ${restoredResponse?.status?.() ?? 'unknown'}.`
        );

        await restoredPage.locator('.workspace').waitFor({ timeout: 90000 });
        const restoredSelectedCount = (await restoredPage
          .locator('.selected-frame .subject-frame-count')
          .first()
          .textContent()) || '';
        assert(
          /\b[1-9]\d*\s+selected\b/i.test(restoredSelectedCount),
          `Expected restored selection count > 0, got "${restoredSelectedCount.trim()}".`
        );
        assert((await restoredPage.locator('.event').count()) > 0, 'Expected calendar events after shared restore.');
        assert(await restoredPage.getByLabel('Show only selected').isChecked(), 'Expected show-only-selected to restore.');
        assert(await restoredPage.getByLabel('Show cancelled').isChecked(), 'Expected show-cancelled to restore.');
        assert(await restoredPage.getByRole('button', { name: 'Week View' }).isVisible(), 'Expected focused day to restore.');
      } finally {
        await restoredContext.close();
      }

      await page.getByRole('button', { name: 'Week View' }).click();
    },
  },
  {
    description: 'Save State pushes a history checkpoint and browser Back restores it',
    run: async ({ page }) => {
      const saveStateButton = page.getByRole('button', { name: 'Save State' });
      await saveStateButton.waitFor({ timeout: 10000 });
      assert(!(await saveStateButton.isDisabled()), 'Expected Save State button to be enabled after loading frames.');

      const checkpointSearch = await page.evaluate(() => window.location.search || '');
      await saveStateButton.click();
      const saveStatus = page.locator('.share-status-success');
      await saveStatus.waitFor({ timeout: 10000 });
      const saveStatusText = (await saveStatus.textContent()) || '';
      assert(/state saved/i.test(saveStatusText), `Expected save-state confirmation, got "${saveStatusText.trim()}".`);

      const showOnlySelected = page.getByLabel('Show only selected');
      await showOnlySelected.uncheck();
      await page.waitForFunction(
        () => new URLSearchParams(window.location.search).get('share_only_sel') === '0',
        { timeout: 10000 }
      );

      await page.goBack();
      await page.waitForFunction(
        (expectedSearch) => window.location.search === expectedSearch,
        checkpointSearch,
        { timeout: 45000 }
      );
      await page.waitForFunction(
        () => {
          const labels = Array.from(document.querySelectorAll('label'));
          const targetLabel = labels.find((label) => /show only selected/i.test(label.textContent || ''));
          const checkbox = targetLabel ? targetLabel.querySelector('input[type="checkbox"]') : null;
          return Boolean(checkbox && checkbox.checked);
        },
        { timeout: 45000 }
      );
      assert(await showOnlySelected.isChecked(), 'Expected Show only selected to be restored from saved history state.');
    },
  },
  {
    description: 'Malformed share query shows an error and keeps the app responsive',
    run: async ({ browser, baseUrl }) => {
      const malformedContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const malformedPage = await malformedContext.newPage();
      try {
        const malformedResponse = await malformedPage.goto(`${baseUrl}/?share_z=not-valid`, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        assert(
          malformedResponse && malformedResponse.ok(),
          `Expected HTTP 200 from malformed share URL, got ${malformedResponse?.status?.() ?? 'unknown'}.`
        );
        await malformedPage.locator('.error-box').waitFor({ timeout: 15000 });
        const errorText = (await malformedPage.locator('.error-box').textContent()) || '';
        assert(/share/i.test(errorText), `Expected malformed share error message, got "${errorText.trim()}".`);
        await malformedPage.getByRole('heading', { name: 'GW Course Studio' }).waitFor({ timeout: 10000 });
      } finally {
        await malformedContext.close();
      }
    },
  },
  {
    description: 'Share URL with preview flag opens PDF preview mode after restore',
    run: async ({ browser }) => {
      assert(lastSharedUrl && lastSharedUrl.includes('share_v='), 'Expected a readable copied share URL from prior step.');
      const previewUrl = new URL(lastSharedUrl);
      previewUrl.searchParams.set('share_preview', '1');

      const previewContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const previewPage = await previewContext.newPage();
      try {
        const previewResponse = await previewPage.goto(previewUrl.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        assert(
          previewResponse && previewResponse.ok(),
          `Expected HTTP 200 from preview share URL, got ${previewResponse?.status?.() ?? 'unknown'}.`
        );
        await previewPage.locator('.app-shell').waitFor({ timeout: 90000 });
        await previewPage.locator('.pdf-preview-toolbar').waitFor({ timeout: 20000 });
        const toolbarText = (await previewPage.locator('.pdf-preview-toolbar').textContent()) || '';
        assert(/preview mode/i.test(toolbarText), `Expected preview toolbar text, got "${toolbarText.trim()}".`);
      } finally {
        await previewContext.close();
      }
    },
  },
  {
    description: 'Share generation uses compressed fallback when readable query URL exceeds limit',
    run: async ({ page }) => {
      await page.getByRole('button', { name: 'Copy share link' }).click();
      await page.locator('.share-status-success').waitFor({ timeout: 10000 });
      const copiedReadableUrl = await page.evaluate(() => window.__gwClipboardText || '');
      assert(
        copiedReadableUrl.includes('share_v='),
        `Expected a readable share URL before fallback check, got "${copiedReadableUrl}".`
      );
      const readableLength = copiedReadableUrl.length;
      const fallbackLimit = Math.max(1, readableLength - 1);

      const readableUrl = new URL(copiedReadableUrl);
      const readableParams = readableUrl.searchParams;
      const termIdFromReadable = readableParams.get('share_t') || '';
      const frameTokens = readableParams.getAll('share_f');
      const frames = frameTokens
        .map((token) => String(token || '').trim())
        .filter(Boolean)
        .map((token) => {
          const [campusId = '', subjectId = ''] = token.split(':');
          return { c: campusId, s: subjectId };
        });
      const selectedCrns = readableParams
        .getAll('share_sel')
        .flatMap((token) =>
          String(token || '')
            .split(',')
            .map((value) => String(value || '').trim())
            .filter(Boolean)
        );
      const payloadForCompression = {
        v: 1,
        t: termIdFromReadable,
        f: frames,
        sc: selectedCrns,
        ui: {
          onlySel: readableParams.get('share_only_sel') === '1',
          showCancel: readableParams.get('share_show_cancel') === '1',
          day: readableParams.get('share_day') || null,
          preview: readableParams.get('share_preview') === '1',
        },
      };
      const expectedCompressedPayload = lzString.compressToEncodedURIComponent(JSON.stringify(payloadForCompression));
      const expectedCompressedUrl = `${readableUrl.origin}${readableUrl.pathname}?share_z=${expectedCompressedPayload}`;
      const compressedShouldFit = expectedCompressedUrl.length <= fallbackLimit;

      await page.evaluate((limit) => {
        window.__GW_SHARE_MAX_URL_LENGTH = limit;
      }, fallbackLimit);

      await page.getByRole('button', { name: 'Copy share link' }).click();
      await page.waitForTimeout(500);
      const copiedAfterFallbackAttempt = await page.evaluate(() => window.__gwClipboardText || '');
      if (compressedShouldFit) {
        assert(copiedAfterFallbackAttempt.includes('share_z='), 'Expected compressed fallback URL to be copied.');
      } else {
        assert(
          copiedAfterFallbackAttempt === copiedReadableUrl,
          'Expected clipboard URL to remain unchanged when compressed fallback exceeds max length.'
        );
      }

      await page.evaluate(() => {
        window.__GW_SHARE_MAX_URL_LENGTH = undefined;
      });
    },
  },
  {
    description: 'Share URL length guard blocks links that are too large even after compression',
    run: async ({ page }) => {
      const copiedBeforeGuard = await page.evaluate(() => window.__gwClipboardText || '');
      await page.evaluate(() => {
        window.__GW_SHARE_MAX_URL_LENGTH = 80;
      });
      await page.getByRole('button', { name: 'Copy share link' }).click();
      const status = page.locator('.share-status-error');
      await status.waitFor({ timeout: 10000 });
      const statusText = (await status.textContent()) || '';
      assert(
        /too large/i.test(statusText),
        `Expected oversize share warning, got "${statusText.trim()}".`
      );
      const copiedAfterGuard = await page.evaluate(() => window.__gwClipboardText || '');
      assert(
        copiedAfterGuard === copiedBeforeGuard,
        'Expected previously copied share URL to remain unchanged after oversize attempt.'
      );
      await page.evaluate(() => {
        window.__GW_SHARE_MAX_URL_LENGTH = undefined;
      });
    },
  },
  {
    description: 'Partial share restore warns but still loads available frames',
    run: async ({ browser, baseUrl }) => {
      assert(lastSharedUrl && lastSharedUrl.includes('share_v='), 'Expected a readable copied share URL from prior step.');
      const copiedUrl = new URL(lastSharedUrl);
      const selectedCrn = copiedUrl.searchParams
        .getAll('share_sel')
        .flatMap((token) =>
          String(token || '')
            .split(',')
            .map((value) => String(value || '').trim())
            .filter(Boolean)
        )
        .find(Boolean);
      assert(selectedCrn, 'Expected selected CRN in decoded share payload.');

      const partialPayload = {
        v: 1,
        t: AUDIT_CONFIG.termId,
        f: [
          { c: AUDIT_CONFIG.campusId, s: AUDIT_CONFIG.subjectId },
          { c: AUDIT_CONFIG.campusId, s: 'ZZZZ' },
        ],
        sc: [selectedCrn],
        ui: { onlySel: true, showCancel: true, day: 'M' },
      };
      const encoded = compressToEncodedURIComponent(JSON.stringify(partialPayload));
      const partialUrl = `${baseUrl}/?share_z=${encoded}`;

      const partialContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const partialPage = await partialContext.newPage();
      try {
        const partialResponse = await partialPage.goto(partialUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        assert(
          partialResponse && partialResponse.ok(),
          `Expected HTTP 200 from partial share URL, got ${partialResponse?.status?.() ?? 'unknown'}.`
        );
        await partialPage.locator('.workspace').waitFor({ timeout: 90000 });
        await partialPage.locator('.error-box').waitFor({ timeout: 20000 });
        const warningText = (await partialPage.locator('.error-box').textContent()) || '';
        assert(
          /failed to load|warning/i.test(warningText),
          `Expected partial-restore warning text, got "${warningText.trim()}".`
        );
      } finally {
        await partialContext.close();
      }
    },
  },
  {
    description: 'Print button enables after selection and invokes browser print',
    run: async ({ page }) => {
      const printCalendarToggle = page.getByLabel('Include calendar in print');
      const printListToggle = page.getByLabel('Include selected course list in print');
      await printCalendarToggle.waitFor({ timeout: 10000 });
      await printListToggle.waitFor({ timeout: 10000 });

      const printButton = page.getByRole('button', { name: 'Print selected schedule' });
      await printButton.waitFor({ timeout: 10000 });
      assert(!(await printButton.isDisabled()), 'Expected Print button to be enabled after selecting a class.');

      await printButton.click();
      const printCallCount = await page.evaluate(() => window.__gwPrintCallCount || 0);
      assert(printCallCount > 0, `Expected window.print to be called, got ${printCallCount}.`);

      await printListToggle.uncheck();
      await page.emulateMedia({ media: 'print' });
      assert(await page.locator('.print-calendar-section').isVisible(), 'Expected calendar print section when Calendar toggle is enabled.');
      assert(!(await page.locator('.print-details-section').isVisible()), 'Expected details print section hidden when Selected Course List toggle is disabled.');
      await page.emulateMedia({ media: 'screen' });

      await printListToggle.check();
      await printCalendarToggle.uncheck();
      await page.emulateMedia({ media: 'print' });
      assert(!(await page.locator('.print-calendar-section').isVisible()), 'Expected calendar print section hidden when Calendar toggle is disabled.');
      assert(await page.locator('.print-details-section').isVisible(), 'Expected details print section when Selected Course List toggle is enabled.');
      await page.emulateMedia({ media: 'screen' });

      await printCalendarToggle.check();

      await printListToggle.uncheck();
      await printCalendarToggle.uncheck();
      assert(await printButton.isDisabled(), 'Expected Print button disabled when all print sections are disabled.');
      await printListToggle.check();
      assert(!(await printButton.isDisabled()), 'Expected Print button re-enabled when one print section is selected.');
    },
  },
  {
    description: 'Print media renders report and hides interactive workspace',
    run: async ({ page }) => {
      await page.emulateMedia({ media: 'print' });
      await page.locator('.print-report').waitFor({ timeout: 10000 });
      assert(await page.locator('.print-report').isVisible(), 'Expected print report to be visible in print media.');
      assert(!(await page.locator('.workspace').isVisible()), 'Expected interactive workspace to be hidden in print media.');

      const printDetailCount = await page.locator('.print-detail-card').count();
      assert(printDetailCount > 0, 'Expected print report to include selected course detail cards.');

      await page.emulateMedia({ media: 'screen' });
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
    description: 'Share URL auto-sync clears share params when selections are cleared',
    run: async ({ page }) => {
      await page.getByRole('button', { name: 'Clear' }).first().click();
      await page.waitForFunction(
        () => !new URLSearchParams(window.location.search).has('share_v'),
        { timeout: 10000 }
      );
      const searchText = await page.evaluate(() => window.location.search || '');
      assert(!/share_/.test(searchText), `Expected share params to be cleared, got "${searchText}".`);
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
    await page.addInitScript(() => {
      window.__gwPrintCallCount = 0;
      window.__gwClipboardText = '';
      window.__GW_SHARE_MAX_URL_LENGTH = undefined;
      window.print = () => {
        window.__gwPrintCallCount = (window.__gwPrintCallCount || 0) + 1;
      };
      const clipboardStub = {
        writeText: async (value) => {
          window.__gwClipboardText = String(value ?? '');
        },
      };
      try {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: clipboardStub,
        });
      } catch {
        try {
          navigator.clipboard = clipboardStub;
        } catch {
          // Ignore if browser disallows overriding clipboard.
        }
      }
    });

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
