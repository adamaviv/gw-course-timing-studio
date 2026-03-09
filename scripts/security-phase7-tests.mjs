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

const VALID_SUBJECTS_HTML =
  '<!doctype html><html><body><a href="/mod/pws/courses.cfm?campId=1&termId=202601&subjId=CSCI">Computer Science</a></body></html>';

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function createStaticFetchMock(responseFactory) {
  let calls = 0;
  return {
    fetch: async () => {
      calls += 1;
      return responseFactory();
    },
    getCalls: () => calls,
  };
}

function createThrowingFetchMock(errorFactory) {
  let calls = 0;
  return {
    fetch: async () => {
      calls += 1;
      throw errorFactory();
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

function request(port, { method, path, headers = {}, payload = null }) {
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

function isValidRequestId(value) {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(String(value ?? ''));
}

async function run() {
  const { server, port } = await startInMemoryServer();

  const tests = [
    {
      description: 'Echoes valid incoming x-request-id on successful responses',
      run: async (failures) => {
        const requestId = 'phase7-req-id-0001';
        const mock = createStaticFetchMock(() => new Response(VALID_SUBJECTS_HTML, { status: 200 }));
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await request(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
            headers: { 'x-request-id': requestId },
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(response.body);
        if (response.status !== 200) {
          failures.push(`expected HTTP 200, got HTTP ${response.status}`);
        }
        if (response.headers['x-request-id'] !== requestId) {
          failures.push(`expected x-request-id=${requestId}, got ${response.headers['x-request-id']}`);
        }
        if (String(body?.subjects?.[0]?.id ?? '') !== 'CSCI') {
          failures.push(`expected subject id CSCI, got "${body?.subjects?.[0]?.id ?? ''}"`);
        }
        if (mock.getCalls() !== 1) {
          failures.push(`expected upstream fetch calls=1, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Replaces invalid incoming x-request-id values',
      run: async (failures) => {
        const invalidRequestId = 'bad id with spaces';
        const mock = createStaticFetchMock(() => new Response(VALID_SUBJECTS_HTML, { status: 200 }));
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await request(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
            headers: { 'x-request-id': invalidRequestId },
          });
        } finally {
          global.fetch = originalFetch;
        }

        const actualRequestId = String(response.headers['x-request-id'] ?? '');
        if (response.status !== 200) {
          failures.push(`expected HTTP 200, got HTTP ${response.status}`);
        }
        if (!actualRequestId) {
          failures.push('expected x-request-id header to be present');
        } else if (actualRequestId === invalidRequestId) {
          failures.push('expected invalid incoming request id to be replaced');
        } else if (!isValidRequestId(actualRequestId)) {
          failures.push(`expected generated request id to match format, got "${actualRequestId}"`);
        }
        if (mock.getCalls() !== 1) {
          failures.push(`expected upstream fetch calls=1, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Redacts internal /api/subjects failures in production and includes requestId',
      run: async (failures) => {
        const secret = 'internal upstream token abc123';
        const mock = createThrowingFetchMock(() => new Error(secret));
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await request(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(response.body);
        const headerRequestId = String(response.headers['x-request-id'] ?? '');
        if (response.status !== 500) {
          failures.push(`expected HTTP 500, got HTTP ${response.status}`);
        }
        if (String(body?.error ?? '') !== 'Internal server error.') {
          failures.push(`expected redacted error message, got "${body?.error ?? response.body}"`);
        }
        if (String(body?.error ?? '').includes(secret)) {
          failures.push('expected secret error text to be redacted from response');
        }
        if (!headerRequestId) {
          failures.push('expected x-request-id header on 500 response');
        }
        if (String(body?.requestId ?? '') !== headerRequestId) {
          failures.push(
            `expected response body requestId to match x-request-id header (${headerRequestId}), got ${body?.requestId}`
          );
        }
        if (mock.getCalls() !== 1) {
          failures.push(`expected upstream fetch calls=1, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Redacts internal /api/parse-url failures in production and includes requestId',
      run: async (failures) => {
        const secret = 'parse-route-secret-xyz';
        const mock = createThrowingFetchMock(() => new Error(secret));
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await request(port, {
            method: 'POST',
            path: '/api/parse-url',
            payload: {
              url: 'https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI',
            },
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(response.body);
        const headerRequestId = String(response.headers['x-request-id'] ?? '');
        if (response.status !== 500) {
          failures.push(`expected HTTP 500, got HTTP ${response.status}`);
        }
        if (String(body?.error ?? '') !== 'Internal server error.') {
          failures.push(`expected redacted error message, got "${body?.error ?? response.body}"`);
        }
        if (String(body?.error ?? '').includes(secret)) {
          failures.push('expected secret error text to be redacted from response');
        }
        if (!headerRequestId) {
          failures.push('expected x-request-id header on 500 response');
        }
        if (String(body?.requestId ?? '') !== headerRequestId) {
          failures.push(
            `expected response body requestId to match x-request-id header (${headerRequestId}), got ${body?.requestId}`
          );
        }
        if (mock.getCalls() !== 1) {
          failures.push(`expected upstream fetch calls=1, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Includes requestId on validation errors',
      run: async (failures) => {
        const mock = createNoFetchExpectedMock();
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await request(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=bad',
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(response.body);
        const headerRequestId = String(response.headers['x-request-id'] ?? '');
        if (response.status !== 400) {
          failures.push(`expected HTTP 400, got HTTP ${response.status}`);
        }
        if (!headerRequestId) {
          failures.push('expected x-request-id header on 400 response');
        }
        if (String(body?.requestId ?? '') !== headerRequestId) {
          failures.push(
            `expected response body requestId to match x-request-id header (${headerRequestId}), got ${body?.requestId}`
          );
        }
        if (!String(body?.error ?? '').includes('termId must be a 6-digit numeric value.')) {
          failures.push(`expected termId validation message, got "${body?.error ?? response.body}"`);
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
