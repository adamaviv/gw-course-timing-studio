#!/usr/bin/env node

import http from 'node:http';

process.env.NO_SERVER = '1';
process.env.NODE_ENV = 'production';
process.env.TRUST_PROXY = '1';
process.env.ALLOWED_ORIGINS = 'https://allowed.example';
process.env.API_RATE_LIMIT_WINDOW_MS = '60000';
process.env.API_RATE_LIMIT_PARSE_MAX = '100';
process.env.API_RATE_LIMIT_SUBJECTS_MAX = '2';
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

function assertRequestIdAndCacheHeaders(response, failures, label) {
  const requestIdHeader = String(response.headers['x-request-id'] ?? '');
  if (!requestIdHeader) {
    failures.push(`${label}: expected x-request-id header`);
  }
  if (!String(response.headers['cache-control'] ?? '').includes('no-store')) {
    failures.push(`${label}: expected cache-control to include no-store`);
  }
  if (String(response.headers['pragma'] ?? '').toLowerCase() !== 'no-cache') {
    failures.push(`${label}: expected pragma=no-cache`);
  }
  return requestIdHeader;
}

async function run() {
  const { server, port } = await startInMemoryServer();

  const tests = [
    {
      description: 'Success responses include request-id and no-store API caching headers',
      run: async (failures) => {
        const mock = createStaticFetchMock(() => new Response(VALID_SUBJECTS_HTML, { status: 200 }));
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await request(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
            headers: { 'x-forwarded-for': '198.51.100.60' },
          });
        } finally {
          global.fetch = originalFetch;
        }

        if (response.status !== 200) {
          failures.push(`expected HTTP 200, got HTTP ${response.status}`);
        }
        assertRequestIdAndCacheHeaders(response, failures, 'success');
        if (mock.getCalls() !== 1) {
          failures.push(`expected upstream fetch calls=1, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: '400 validation errors keep JSON shape with requestId',
      run: async (failures) => {
        const mock = createNoFetchExpectedMock();
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await request(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=bad',
            headers: { 'x-forwarded-for': '198.51.100.61' },
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(response.body);
        const requestIdHeader = assertRequestIdAndCacheHeaders(response, failures, '400');
        if (response.status !== 400) {
          failures.push(`expected HTTP 400, got HTTP ${response.status}`);
        }
        if (!String(response.headers['content-type'] ?? '').includes('application/json')) {
          failures.push(`expected application/json content-type, got ${response.headers['content-type']}`);
        }
        if (!String(body?.error ?? '').includes('termId must be a 6-digit numeric value.')) {
          failures.push(`expected termId validation error, got "${body?.error ?? response.body}"`);
        }
        if (String(body?.requestId ?? '') !== requestIdHeader) {
          failures.push(
            `expected response body requestId to match x-request-id header (${requestIdHeader}), got ${body?.requestId}`
          );
        }
        if (mock.getCalls() !== 0) {
          failures.push(`expected upstream fetch calls=0, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: '403 CORS blocks include requestId and do not emit access-control-allow-origin',
      run: async (failures) => {
        const mock = createNoFetchExpectedMock();
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await request(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
            headers: {
              Origin: 'https://evil.example',
              'x-forwarded-for': '198.51.100.62',
            },
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(response.body);
        const requestIdHeader = assertRequestIdAndCacheHeaders(response, failures, '403');
        if (response.status !== 403) {
          failures.push(`expected HTTP 403, got HTTP ${response.status}`);
        }
        if (!String(body?.error ?? '').includes('Origin not allowed')) {
          failures.push(`expected origin block error, got "${body?.error ?? response.body}"`);
        }
        if (String(body?.requestId ?? '') !== requestIdHeader) {
          failures.push(
            `expected response body requestId to match x-request-id header (${requestIdHeader}), got ${body?.requestId}`
          );
        }
        if (response.headers['access-control-allow-origin']) {
          failures.push(`expected no access-control-allow-origin header, got ${response.headers['access-control-allow-origin']}`);
        }
        if (mock.getCalls() !== 0) {
          failures.push(`expected upstream fetch calls=0, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: '429 rate-limit responses include retry + requestId + no-store headers',
      run: async (failures) => {
        const mock = createStaticFetchMock(() => new Response(VALID_SUBJECTS_HTML, { status: 200 }));
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let first;
        let second;
        let third;

        try {
          const headers = { 'x-forwarded-for': '198.51.100.63' };
          first = await request(port, { method: 'GET', path: '/api/subjects?campId=1&termId=202601', headers });
          second = await request(port, { method: 'GET', path: '/api/subjects?campId=1&termId=202601', headers });
          third = await request(port, { method: 'GET', path: '/api/subjects?campId=1&termId=202601', headers });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(third.body);
        const requestIdHeader = assertRequestIdAndCacheHeaders(third, failures, '429');
        if (first.status !== 200 || second.status !== 200) {
          failures.push(`expected first two statuses 200/200, got ${first.status}/${second.status}`);
        }
        if (third.status !== 429) {
          failures.push(`expected third status HTTP 429, got HTTP ${third.status}`);
        }
        if (!String(body?.error ?? '').includes('Rate limit exceeded for /api/subjects')) {
          failures.push(`expected rate-limit error, got "${body?.error ?? third.body}"`);
        }
        if (String(body?.requestId ?? '') !== requestIdHeader) {
          failures.push(
            `expected response body requestId to match x-request-id header (${requestIdHeader}), got ${body?.requestId}`
          );
        }
        if (!third.headers['retry-after']) {
          failures.push('expected Retry-After header on 429 response');
        }
        if (!third.headers['x-ratelimit-limit'] || !third.headers['x-ratelimit-remaining']) {
          failures.push('expected rate-limit headers on 429 response');
        }
        if (mock.getCalls() !== 2) {
          failures.push(`expected upstream fetch calls=2 before limit, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: '500 responses remain generic and include requestId + no-store headers',
      run: async (failures) => {
        const secret = 'phase8-sensitive-secret';
        const mock = createThrowingFetchMock(() => new Error(secret));
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await request(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
            headers: { 'x-forwarded-for': '198.51.100.64' },
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(response.body);
        const requestIdHeader = assertRequestIdAndCacheHeaders(response, failures, '500');
        if (response.status !== 500) {
          failures.push(`expected HTTP 500, got HTTP ${response.status}`);
        }
        if (String(body?.error ?? '') !== 'Internal server error.') {
          failures.push(`expected redacted 500 message, got "${body?.error ?? response.body}"`);
        }
        if (String(body?.error ?? '').includes(secret)) {
          failures.push('expected sensitive text to be redacted from 500 body');
        }
        if (String(body?.requestId ?? '') !== requestIdHeader) {
          failures.push(
            `expected response body requestId to match x-request-id header (${requestIdHeader}), got ${body?.requestId}`
          );
        }
        if (mock.getCalls() !== 1) {
          failures.push(`expected upstream fetch calls=1, got ${mock.getCalls()}`);
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
