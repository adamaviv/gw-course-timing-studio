#!/usr/bin/env node

import http from 'node:http';

process.env.NO_SERVER = '1';
const { app } = await import('../server/index.js');

const EMPTY_HTML = '<!doctype html><html><body><table></table></body></html>';

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function mockResponse(status, body = '', headers = {}) {
  return new Response(body, { status, headers });
}

function createSequenceFetchMock(steps) {
  let calls = 0;

  return {
    fetch: async () => {
      const step = steps[calls];
      calls += 1;

      if (!step) {
        throw new Error(`Unexpected upstream fetch call #${calls}.`);
      }

      if (typeof step === 'function') {
        return step();
      }
      return step;
    },
    getCalls: () => calls,
  };
}

function createNoFetchExpectedMock() {
  let calls = 0;
  return {
    fetch: async () => {
      calls += 1;
      throw new Error('Upstream fetch should not be called for this case.');
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

const TESTS = [
  {
    description: 'Accepts canonical HTTPS print.cfm schedule URLs',
    payload: {
      url: 'https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI',
    },
    expectedStatus: 422,
    expectedErrorIncludes: 'No classes are currently published',
    expectedFetchCalls: 1,
    createMock: () => createSequenceFetchMock([mockResponse(200, EMPTY_HTML, { 'content-type': 'text/html' })]),
  },
  {
    description: 'Accepts canonical HTTPS courses.cfm schedule URLs',
    payload: {
      url: 'https://my.gwu.edu/mod/pws/courses.cfm?campId=1&termId=202601&subjId=CSCI',
    },
    expectedStatus: 422,
    expectedErrorIncludes: 'No classes are currently published',
    expectedFetchCalls: 1,
    createMock: () => createSequenceFetchMock([mockResponse(200, EMPTY_HTML, { 'content-type': 'text/html' })]),
  },
  {
    description: 'Rejects non-HTTPS URLs',
    payload: {
      url: 'http://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI',
    },
    expectedStatus: 400,
    expectedErrorIncludes: 'Only HTTPS my.gwu.edu schedule pages are supported.',
    expectedFetchCalls: 0,
    createMock: () => createNoFetchExpectedMock(),
  },
  {
    description: 'Rejects non-my.gwu.edu hosts',
    payload: {
      url: 'https://example.com/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI',
    },
    expectedStatus: 400,
    expectedErrorIncludes: 'Only my.gwu.edu schedule pages are supported.',
    expectedFetchCalls: 0,
    createMock: () => createNoFetchExpectedMock(),
  },
  {
    description: 'Rejects non-allowlisted PWS paths',
    payload: {
      url: 'https://my.gwu.edu/mod/pws/subjects.cfm?campId=1&termId=202601&subjId=CSCI',
    },
    expectedStatus: 400,
    expectedErrorIncludes: 'URL must point to /mod/pws/print.cfm or /mod/pws/courses.cfm.',
    expectedFetchCalls: 0,
    createMock: () => createNoFetchExpectedMock(),
  },
  {
    description: 'Rejects unknown query parameters',
    payload: {
      url: 'https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI&next=https://evil.test',
    },
    expectedStatus: 400,
    expectedErrorIncludes: 'Unsupported query parameter: next.',
    expectedFetchCalls: 0,
    createMock: () => createNoFetchExpectedMock(),
  },
  {
    description: 'Rejects missing required query parameters',
    payload: {
      url: 'https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601',
    },
    expectedStatus: 400,
    expectedErrorIncludes: 'URL must include exactly one campId, termId, and subjId parameter.',
    expectedFetchCalls: 0,
    createMock: () => createNoFetchExpectedMock(),
  },
  {
    description: 'Rejects invalid termId format',
    payload: {
      url: 'https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=2026&subjId=CSCI',
    },
    expectedStatus: 400,
    expectedErrorIncludes: 'termId must be a 6-digit numeric value.',
    expectedFetchCalls: 0,
    createMock: () => createNoFetchExpectedMock(),
  },
  {
    description: 'Rejects credentials embedded in URL',
    payload: {
      url: 'https://user:pass@my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI',
    },
    expectedStatus: 400,
    expectedErrorIncludes: 'URL must not include credentials or a custom port.',
    expectedFetchCalls: 0,
    createMock: () => createNoFetchExpectedMock(),
  },
  {
    description: 'Rejects custom URL ports',
    payload: {
      url: 'https://my.gwu.edu:444/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI',
    },
    expectedStatus: 400,
    expectedErrorIncludes: 'URL must not include credentials or a custom port.',
    expectedFetchCalls: 0,
    createMock: () => createNoFetchExpectedMock(),
  },
  {
    description: 'Rejects duplicate required query parameters',
    payload: {
      url: 'https://my.gwu.edu/mod/pws/print.cfm?campId=1&campId=2&termId=202601&subjId=CSCI',
    },
    expectedStatus: 400,
    expectedErrorIncludes: 'URL must include exactly one campId, termId, and subjId parameter.',
    expectedFetchCalls: 0,
    createMock: () => createNoFetchExpectedMock(),
  },
  {
    description: 'Rejects redirects to non-allowlisted hosts',
    payload: {
      url: 'https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI',
    },
    expectedStatus: 502,
    expectedErrorIncludes: 'Only my.gwu.edu schedule pages are supported.',
    expectedFetchCalls: 1,
    createMock: () =>
      createSequenceFetchMock([
        mockResponse(302, '', {
          location: 'https://evil.example/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI',
        }),
      ]),
  },
  {
    description: 'Follows redirects to allowlisted GW schedule URLs',
    payload: {
      url: 'https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI',
    },
    expectedStatus: 422,
    expectedErrorIncludes: 'No classes are currently published',
    expectedFetchCalls: 2,
    createMock: () =>
      createSequenceFetchMock([
        mockResponse(302, '', {
          location: 'https://my.gwu.edu/mod/pws/courses.cfm?campId=1&termId=202601&subjId=CSCI',
        }),
        mockResponse(200, EMPTY_HTML, { 'content-type': 'text/html' }),
      ]),
  },
];

async function run() {
  const { server, port } = await startInMemoryServer();
  let passed = 0;
  let failed = 0;

  try {
    for (let index = 0; index < TESTS.length; index += 1) {
      const test = TESTS[index];
      const mock = test.createMock();
      const originalFetch = global.fetch;
      let response;
      let runtimeError = null;

      global.fetch = mock.fetch;
      try {
        response = await postJson(port, '/api/parse-url', test.payload);
      } catch (error) {
        runtimeError = error instanceof Error ? error : new Error(String(error));
      } finally {
        global.fetch = originalFetch;
      }

      const failures = [];
      if (runtimeError) {
        failures.push(`runtime error: ${runtimeError.message}`);
      } else {
        if (response.status !== test.expectedStatus) {
          failures.push(`expected HTTP ${test.expectedStatus}, got HTTP ${response.status}`);
        }

        const parsedBody = safeJsonParse(response.body);
        const errorText = parsedBody?.error ? String(parsedBody.error) : String(response.body ?? '');
        if (test.expectedErrorIncludes && !errorText.includes(test.expectedErrorIncludes)) {
          failures.push(`expected response to include "${test.expectedErrorIncludes}" but got "${errorText}"`);
        }
      }

      const fetchCalls = mock.getCalls();
      if (fetchCalls !== test.expectedFetchCalls) {
        failures.push(`expected upstream fetch calls=${test.expectedFetchCalls}, got ${fetchCalls}`);
      }

      const label = `${String(index + 1).padStart(2, '0')}. ${test.description}`;
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
  } finally {
    await stopInMemoryServer(server);
  }

  console.log(`\nSummary: ${passed}/${TESTS.length} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(`Fatal test runner error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
