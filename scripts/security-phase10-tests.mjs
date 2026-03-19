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

const MOCK_SUBJECTS_RESPONSE = {
  meta: {
    sourceUrl: 'https://my.gwu.edu/mod/pws/subjects.cfm?campId=1&termId=202601',
    campId: '1',
    campusLabel: 'Main Campus',
    termId: '202601',
    termLabel: 'Spring 2026',
    subjectCount: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
  },
  subjects: [{ id: 'CSCI', name: 'Computer Science', label: 'CSCI - Computer Science' }],
};

const MOCK_PARSE_RESPONSE = {
  meta: {
    sourceUrl: 'https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI',
    termLabel: 'Spring 2026',
    subjectLabel: 'CSCI',
    campusId: '1',
    campusLabel: 'Main Campus',
    parsedCourseCount: 1,
    rawRowCount: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
  },
  courses: [
    {
      id: 'row-1',
      status: 'OPEN',
      crn: '12345',
      courseNumber: 'CSCI 1012',
      subject: 'CSCI',
      numeric: 1012,
      section: '10',
      title: 'Intro to Programming',
      normalizedTitle: 'intro to programming',
      credits: '3.00',
      instructor: 'Doe, J',
      room: 'ROME 101',
      dayTimeRaw: 'M 01:00PM - 02:00PM',
      dateRange: '01/12/26 - 04/27/26',
      meetings: [
        {
          day: 'M',
          dayName: 'Monday',
          startMin: 780,
          endMin: 840,
          startLabel: '1:00 PM',
          endLabel: '2:00 PM',
        },
      ],
      meetingSignature: 'M:780-840',
      termLabel: 'Spring 2026',
      sourceUrl: 'https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI',
      relationType: 'primary',
      linkedParentCrn: '',
      detailUrl: '',
      scheduleDetails: [],
      commentDetails: [],
      instructorDetails: [{ courseNumber: 'CSCI 1012', instructor: 'Doe, J' }],
      titleDetails: [{ courseNumber: 'CSCI 1012', title: 'Intro to Programming' }],
      registrationDetails: [{ courseNumber: 'CSCI 1012', sections: ['10'], crns: ['12345'] }],
    },
  ],
};

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
        probe.close(() => reject(new Error('Could not reserve local port for phase 10 security tests.')));
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server at ${baseUrl} did not become ready within ${timeoutMs}ms.`);
}

function shareUrl(baseUrl, payload) {
  const encoded = compressToEncodedURIComponent(JSON.stringify(payload));
  return `${baseUrl}/?share_z=${encoded}`;
}

function manyFrames(count) {
  const frames = [];
  for (let index = 0; index < count; index += 1) {
    frames.push({
      c: '1',
      s: `S${String(index).padStart(3, '0')}`,
    });
  }
  return frames;
}

async function runStep(description, run) {
  try {
    await run();
    console.log(`PASS ${description}`);
    return true;
  } catch (error) {
    console.log(`FAIL ${description}`);
    console.log(`  - ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function newPageWithApiMocks(browser, baseUrl) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const counters = { parseCalls: 0, subjectsCalls: 0 };

  await page.route('**/api/subjects**', async (route) => {
    counters.subjectsCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_SUBJECTS_RESPONSE),
    });
  });

  await page.route('**/api/parse-url', async (route) => {
    counters.parseCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_PARSE_RESPONSE),
    });
  });

  return { context, page, counters, baseUrl };
}

async function run() {
  const port = await reservePort();
  process.env.PORT = String(port);
  await startServer();
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServerReady(baseUrl);

  const browser = await chromium.launch({ headless: true });
  let failed = false;

  try {
    const oversizedPayloadPassed = await runStep(
      'Oversized decompressed share payload is rejected before restore requests',
      async () => {
        const { context, page, counters } = await newPageWithApiMocks(browser, baseUrl);
        try {
          const payload = {
            v: 1,
            t: '202601',
            f: [{ c: '1', s: 'CSCI' }],
            sc: ['12345'],
            ui: { onlySel: false, showCancel: false, day: null, preview: false },
            junk: 'x'.repeat(130000),
          };
          const response = await page.goto(shareUrl(baseUrl, payload), {
            waitUntil: 'domcontentloaded',
            timeout: 45000,
          });
          assert(response && response.ok(), `Expected HTTP 200 for oversized payload URL, got ${response?.status?.() ?? 'unknown'}.`);
          await page.locator('.error-box').waitFor({ timeout: 15000 });
          const text = (await page.locator('.error-box').textContent()) || '';
          assert(
            /exceeds maximum allowed size/i.test(text),
            `Expected oversized payload error message, got "${text.trim()}".`
          );
          assert(counters.parseCalls === 0, `Expected parse restore calls=0, got ${counters.parseCalls}.`);
        } finally {
          await context.close();
        }
      }
    );
    if (!oversizedPayloadPassed) {
      failed = true;
      return;
    }

    const frameLimitPassed = await runStep(
      'Share payload with too many frames is rejected before restore requests',
      async () => {
        const { context, page, counters } = await newPageWithApiMocks(browser, baseUrl);
        try {
          const payload = {
            v: 1,
            t: '202601',
            f: manyFrames(25),
            sc: [],
            ui: { onlySel: false, showCancel: false, day: null, preview: false },
          };
          const response = await page.goto(shareUrl(baseUrl, payload), {
            waitUntil: 'domcontentloaded',
            timeout: 45000,
          });
          assert(response && response.ok(), `Expected HTTP 200 for too-many-frames URL, got ${response?.status?.() ?? 'unknown'}.`);
          await page.locator('.error-box').waitFor({ timeout: 15000 });
          const text = (await page.locator('.error-box').textContent()) || '';
          assert(/too many subject frames/i.test(text), `Expected frame-limit error message, got "${text.trim()}".`);
          assert(counters.parseCalls === 0, `Expected parse restore calls=0, got ${counters.parseCalls}.`);
        } finally {
          await context.close();
        }
      }
    );
    if (!frameLimitPassed) {
      failed = true;
      return;
    }

    const validPayloadPassed = await runStep(
      'Valid compressed share payload still restores and triggers bounded API restore',
      async () => {
        const { context, page, counters } = await newPageWithApiMocks(browser, baseUrl);
        try {
          const payload = {
            v: 1,
            t: '202601',
            f: [{ c: '1', s: 'CSCI' }],
            sc: ['12345'],
            ui: { onlySel: true, showCancel: false, day: 'M', preview: false },
          };
          const response = await page.goto(shareUrl(baseUrl, payload), {
            waitUntil: 'domcontentloaded',
            timeout: 45000,
          });
          assert(response && response.ok(), `Expected HTTP 200 for valid payload URL, got ${response?.status?.() ?? 'unknown'}.`);
          await page.locator('.workspace').waitFor({ timeout: 20000 });
          assert(counters.parseCalls === 1, `Expected parse restore calls=1 for valid payload, got ${counters.parseCalls}.`);
        } finally {
          await context.close();
        }
      }
    );
    if (!validPayloadPassed) {
      failed = true;
    }
  } finally {
    await browser.close();
  }

  if (failed) {
    process.exit(1);
  }

  process.exit(0);
}

await run();
