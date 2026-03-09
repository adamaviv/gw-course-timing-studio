#!/usr/bin/env node

import http from 'node:http';

process.env.NO_SERVER = '1';
process.env.NODE_ENV = 'production';
process.env.TRUST_PROXY = '0';
process.env.API_RATE_LIMIT_WINDOW_MS = '60000';
process.env.API_RATE_LIMIT_PARSE_MAX = '100';
process.env.API_RATE_LIMIT_SUBJECTS_MAX = '100';
process.env.UPSTREAM_FETCH_TIMEOUT_MS = '5000';
process.env.UPSTREAM_MAX_RESPONSE_BYTES = '2097152';

const { app } = await import('../server/index.js');

const SUBJECTS_HTML_VALID =
  '<!doctype html><html><body><a href="/mod/pws/courses.cfm?campId=1&termId=202601&subjId=CSCI">Computer Science</a></body></html>';
const SUBJECTS_HTML_EXTERNAL_HOST =
  '<!doctype html><html><body><a href="https://evil.example/mod/pws/courses.cfm?subjId=EVIL">Evil Subject</a></body></html>';
const SUBJECTS_HTML_MALFORMED_SUBJECT =
  '<!doctype html><html><body><a href="/mod/pws/courses.cfm?subjId=CSCI%3Cscript%3E">Computer Science</a></body></html>';

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

function requestJson(port, { method, path, payload = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const body = payload == null ? '' : JSON.stringify(payload);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(payload == null
            ? {}
            : {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              }),
          ...headers,
        },
      },
      (res) => {
        let rawBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          rawBody += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: rawBody,
            headers: res.headers,
          });
        });
      }
    );

    req.on('error', reject);
    if (payload != null) {
      req.write(body);
    }
    req.end();
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

async function runSingleTest({ description, run }) {
  const failures = [];
  try {
    await run(failures);
  } catch (error) {
    failures.push(`runtime error: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (failures.length === 0) {
    console.log(`PASS ${description}`);
    return true;
  }

  console.log(`FAIL ${description}`);
  for (const failure of failures) {
    console.log(`  - ${failure}`);
  }
  return false;
}

async function run() {
  const { server, port } = await startInMemoryServer();

  const tests = [
    {
      description: 'Blocks redirects from /api/subjects to non-allowlisted hosts',
      run: async (failures) => {
        const mock = createSequenceFetchMock([
          mockResponse(302, '', {
            location: 'https://evil.example/mod/pws/subjects.cfm?campId=1&termId=202601',
          }),
        ]);
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await requestJson(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(response.body);
        if (response.status !== 502) {
          failures.push(`expected HTTP 502, got HTTP ${response.status}`);
        }
        if (!String(body?.error ?? '').includes('Only my.gwu.edu subjects pages are supported.')) {
          failures.push(`expected non-allowlisted-host error, got "${body?.error ?? response.body}"`);
        }
        if (mock.getCalls() !== 1) {
          failures.push(`expected upstream fetch calls=1, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Blocks redirects from /api/subjects to non-allowlisted paths',
      run: async (failures) => {
        const mock = createSequenceFetchMock([
          mockResponse(302, '', {
            location: 'https://my.gwu.edu/mod/pws/courses.cfm?campId=1&termId=202601&subjId=CSCI',
          }),
        ]);
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await requestJson(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(response.body);
        if (response.status !== 502) {
          failures.push(`expected HTTP 502, got HTTP ${response.status}`);
        }
        if (!String(body?.error ?? '').includes('URL must point to /mod/pws/subjects.cfm.')) {
          failures.push(`expected non-allowlisted-path error, got "${body?.error ?? response.body}"`);
        }
        if (mock.getCalls() !== 1) {
          failures.push(`expected upstream fetch calls=1, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Follows allowlisted redirects for /api/subjects',
      run: async (failures) => {
        const mock = createSequenceFetchMock([
          mockResponse(302, '', {
            location: 'https://my.gwu.edu/mod/pws/subjects.cfm?termId=202601&campId=1',
          }),
          mockResponse(200, SUBJECTS_HTML_VALID, { 'content-type': 'text/html' }),
        ]);
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await requestJson(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(response.body);
        if (response.status !== 200) {
          failures.push(`expected HTTP 200, got HTTP ${response.status}`);
        }
        if (String(body?.meta?.sourceUrl ?? '') !== 'https://my.gwu.edu/mod/pws/subjects.cfm?campId=1&termId=202601') {
          failures.push(`expected canonical final sourceUrl, got "${body?.meta?.sourceUrl ?? ''}"`);
        }
        if (String(body?.subjects?.[0]?.id ?? '') !== 'CSCI') {
          failures.push(`expected first subject id to be CSCI, got "${body?.subjects?.[0]?.id ?? ''}"`);
        }
        if (mock.getCalls() !== 2) {
          failures.push(`expected upstream fetch calls=2, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Ignores external-host subject links in subjects HTML',
      run: async (failures) => {
        const mock = createSequenceFetchMock([mockResponse(200, SUBJECTS_HTML_EXTERNAL_HOST, { 'content-type': 'text/html' })]);
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await requestJson(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(response.body);
        if (response.status !== 422) {
          failures.push(`expected HTTP 422, got HTTP ${response.status}`);
        }
        if (!String(body?.error ?? '').includes('No subjects are currently published')) {
          failures.push(`expected no-subjects error, got "${body?.error ?? response.body}"`);
        }
        if (mock.getCalls() !== 1) {
          failures.push(`expected upstream fetch calls=1, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Ignores malformed subjId values in subjects HTML',
      run: async (failures) => {
        const mock = createSequenceFetchMock([
          mockResponse(200, SUBJECTS_HTML_MALFORMED_SUBJECT, { 'content-type': 'text/html' }),
        ]);
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await requestJson(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(response.body);
        if (response.status !== 422) {
          failures.push(`expected HTTP 422, got HTTP ${response.status}`);
        }
        if (!String(body?.error ?? '').includes('No subjects are currently published')) {
          failures.push(`expected no-subjects error, got "${body?.error ?? response.body}"`);
        }
        if (mock.getCalls() !== 1) {
          failures.push(`expected upstream fetch calls=1, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Rejects invalid termId format for /api/subjects before upstream fetch',
      run: async (failures) => {
        const mock = createNoFetchExpectedMock();
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await requestJson(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=20261',
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(response.body);
        if (response.status !== 400) {
          failures.push(`expected HTTP 400, got HTTP ${response.status}`);
        }
        if (!String(body?.error ?? '').includes('termId must be a 6-digit numeric value.')) {
          failures.push(`expected termId validation error, got "${body?.error ?? response.body}"`);
        }
        if (mock.getCalls() !== 0) {
          failures.push(`expected upstream fetch calls=0, got ${mock.getCalls()}`);
        }
      },
    },
  ];

  let passed = 0;
  let failed = 0;

  try {
    for (const test of tests) {
      const didPass = await runSingleTest(test);
      if (didPass) {
        passed += 1;
      } else {
        failed += 1;
      }
    }
  } finally {
    await stopInMemoryServer(server);
  }

  console.log(`\nSummary: ${passed}/${tests.length} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(`Fatal test runner error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
