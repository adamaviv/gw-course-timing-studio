#!/usr/bin/env node

import http from 'node:http';
import { sanitizeDetailUrl } from '../shared/detailUrl.js';

process.env.NO_SERVER = '1';
const { app } = await import('../server/index.js');

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildCourseHtml(detailHref) {
  const hrefAttribute =
    detailHref == null ? '' : ` href="${escapeHtmlAttribute(detailHref)}"`;

  return `<!doctype html>
<html>
  <body>
    <table>
      <tr class="coursetable crseRow1">
        <td>OPEN</td>
        <td>12345</td>
        <td><a${hrefAttribute}>CSCI 1012</a></td>
        <td>10</td>
        <td>Intro to Programming</td>
        <td>3.00</td>
        <td>Doe, J</td>
        <td>ROME 101</td>
        <td>M 01:00PM - 02:00PM</td>
        <td>01/12/26 - 04/27/26</td>
      </tr>
    </table>
  </body>
</html>`;
}

function createSingleResponseFetchMock(response) {
  let calls = 0;
  return {
    fetch: async () => {
      calls += 1;
      return response;
    },
    getCalls: () => calls,
  };
}

function postJson(port, path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        let rawBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          rawBody += chunk;
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: rawBody,
          });
        });
      }
    );

    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function startInMemoryServer() {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not determine test server port.'));
        return;
      }
      resolve({ server, port: address.port });
    });
    server.on('error', reject);
  });
}

async function stopInMemoryServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

const SERVER_LINK_TESTS = [
  {
    description: 'Strips javascript: detail links from upstream HTML',
    href: 'javascript:alert(1)',
    expectedDetailUrl: '',
  },
  {
    description: 'Strips data: detail links from upstream HTML',
    href: 'data:text/html,<script>alert(1)</script>',
    expectedDetailUrl: '',
  },
  {
    description: 'Strips non-allowlisted external hosts',
    href: 'https://evil.example/catalog',
    expectedDetailUrl: '',
  },
  {
    description: 'Upgrades allowlisted bulletin HTTP links to HTTPS',
    href: 'http://bulletin.gwu.edu/search/?P=CSCI+1012',
    expectedDetailUrl: 'https://bulletin.gwu.edu/search/?P=CSCI+1012',
  },
  {
    description: 'Allows relative links that resolve to my.gwu.edu',
    href: '/mod/pws/courses.cfm?campId=1&termId=202601&subjId=CSCI#frag',
    expectedDetailUrl: 'https://my.gwu.edu/mod/pws/courses.cfm?campId=1&termId=202601&subjId=CSCI',
  },
  {
    description: 'Returns empty detail link when href is missing',
    href: null,
    expectedDetailUrl: '',
  },
];

const SHARED_SANITIZER_TESTS = [
  {
    description: 'Shared sanitizer rejects javascript URLs',
    input: 'javascript:alert(1)',
    expected: '',
  },
  {
    description: 'Shared sanitizer upgrades bulletin http links',
    input: 'http://bulletin.gwu.edu/search/?P=CSCI+1012',
    expected: 'https://bulletin.gwu.edu/search/?P=CSCI+1012',
  },
  {
    description: 'Shared sanitizer rejects unknown hosts',
    input: 'https://evil.example/catalog',
    expected: '',
  },
  {
    description: 'Shared sanitizer removes URL fragments',
    input: 'https://my.gwu.edu/mod/pws/courses.cfm?campId=1&termId=202601&subjId=CSCI#abc',
    expected: 'https://my.gwu.edu/mod/pws/courses.cfm?campId=1&termId=202601&subjId=CSCI',
  },
];

async function runServerLinkTests(port) {
  let passed = 0;
  let failed = 0;

  for (let index = 0; index < SERVER_LINK_TESTS.length; index += 1) {
    const test = SERVER_LINK_TESTS[index];
    const responseHtml = buildCourseHtml(test.href);
    const fetchMock = createSingleResponseFetchMock(
      new Response(responseHtml, { status: 200, headers: { 'content-type': 'text/html' } })
    );

    const originalFetch = global.fetch;
    global.fetch = fetchMock.fetch;

    let result;
    let runtimeError = null;
    try {
      result = await postJson(port, '/api/parse-url', {
        url: 'https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI',
      });
    } catch (error) {
      runtimeError = error instanceof Error ? error : new Error(String(error));
    } finally {
      global.fetch = originalFetch;
    }

    const failures = [];
    if (runtimeError) {
      failures.push(`runtime error: ${runtimeError.message}`);
    } else {
      if (result.status !== 200) {
        failures.push(`expected HTTP 200, got HTTP ${result.status}`);
      }

      const parsedBody = safeJsonParse(result.body);
      const detailUrl = parsedBody?.courses?.[0]?.detailUrl ?? '';
      if (detailUrl !== test.expectedDetailUrl) {
        failures.push(`expected detailUrl "${test.expectedDetailUrl}" but got "${detailUrl}"`);
      }
    }

    if (fetchMock.getCalls() !== 1) {
      failures.push(`expected upstream fetch calls=1, got ${fetchMock.getCalls()}`);
    }

    const label = `Server ${String(index + 1).padStart(2, '0')}. ${test.description}`;
    if (failures.length === 0) {
      passed += 1;
      console.log(`PASS ${label}`);
    } else {
      failed += 1;
      console.log(`FAIL ${label}`);
      for (const detail of failures) {
        console.log(`  - ${detail}`);
      }
    }
  }

  return { passed, failed, total: SERVER_LINK_TESTS.length };
}

function runSharedSanitizerTests() {
  let passed = 0;
  let failed = 0;

  for (let index = 0; index < SHARED_SANITIZER_TESTS.length; index += 1) {
    const test = SHARED_SANITIZER_TESTS[index];
    const actual = sanitizeDetailUrl(test.input);
    const label = `Shared ${String(index + 1).padStart(2, '0')}. ${test.description}`;

    if (actual === test.expected) {
      passed += 1;
      console.log(`PASS ${label}`);
    } else {
      failed += 1;
      console.log(`FAIL ${label}`);
      console.log(`  - expected "${test.expected}" but got "${actual}"`);
    }
  }

  return { passed, failed, total: SHARED_SANITIZER_TESTS.length };
}

async function run() {
  const { server, port } = await startInMemoryServer();
  let serverResults;

  try {
    serverResults = await runServerLinkTests(port);
  } finally {
    await stopInMemoryServer(server);
  }

  const sharedResults = runSharedSanitizerTests();
  const total = serverResults.total + sharedResults.total;
  const passed = serverResults.passed + sharedResults.passed;
  const failed = serverResults.failed + sharedResults.failed;

  console.log(`\nSummary: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(`Fatal test runner error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
