#!/usr/bin/env node

import http from 'node:http';

process.env.NO_SERVER = '1';
process.env.NODE_ENV = 'production';
process.env.ALLOWED_ORIGINS = 'https://allowed.example,http://localhost:8787';
process.env.API_RATE_LIMIT_PARSE_MAX = '100';
process.env.API_RATE_LIMIT_SUBJECTS_MAX = '100';
process.env.API_RATE_LIMIT_WINDOW_MS = '60000';
process.env.UPSTREAM_FETCH_TIMEOUT_MS = '5000';
process.env.UPSTREAM_MAX_RESPONSE_BYTES = '2097152';
process.env.CORS_MAX_AGE_SECONDS = '600';

const { app } = await import('../server/index.js');

const SUBJECTS_HTML =
  '<!doctype html><html><body><a href="/mod/pws/courses.cfm?subjId=CSCI">Computer Science</a></body></html>';

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

function createNoFetchExpectedMock() {
  let calls = 0;
  return {
    fetch: async () => {
      calls += 1;
      throw new Error('Upstream fetch should not be called for this test case.');
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

function includesCaseInsensitive(value, needle) {
  return String(value ?? '')
    .toLowerCase()
    .includes(String(needle ?? '').toLowerCase());
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
      description: 'Allows configured CORS origin and returns helmet security headers',
      run: async (failures) => {
        const mock = createStaticFetchMock(() => new Response(SUBJECTS_HTML, { status: 200 }));
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await request(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
            headers: { Origin: 'https://allowed.example' },
          });
        } finally {
          global.fetch = originalFetch;
        }

        if (response.status !== 200) {
          failures.push(`expected HTTP 200, got HTTP ${response.status}`);
        }
        if (response.headers['access-control-allow-origin'] !== 'https://allowed.example') {
          failures.push(
            `expected access-control-allow-origin=https://allowed.example, got ${response.headers['access-control-allow-origin']}`
          );
        }
        if (response.headers['x-content-type-options'] !== 'nosniff') {
          failures.push(`expected x-content-type-options=nosniff, got ${response.headers['x-content-type-options']}`);
        }
        if (response.headers['x-frame-options'] !== 'DENY') {
          failures.push(`expected x-frame-options=DENY, got ${response.headers['x-frame-options']}`);
        }
        if (response.headers['referrer-policy'] !== 'no-referrer') {
          failures.push(`expected referrer-policy=no-referrer, got ${response.headers['referrer-policy']}`);
        }
        if (!includesCaseInsensitive(response.headers['content-security-policy'], "default-src 'self'")) {
          failures.push('expected content-security-policy header to include default-src self');
        }
        if (mock.getCalls() !== 1) {
          failures.push(`expected upstream fetch calls=1, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Blocks disallowed CORS origin before upstream fetch',
      run: async (failures) => {
        const mock = createNoFetchExpectedMock();
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await request(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
            headers: { Origin: 'https://evil.example' },
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(response.body);
        if (response.status !== 403) {
          failures.push(`expected HTTP 403, got HTTP ${response.status}`);
        }
        if (!String(body?.error ?? '').includes('Origin not allowed')) {
          failures.push(`expected origin-block error message, got "${body?.error ?? response.body}"`);
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
      description: 'Allows CORS preflight for configured origin',
      run: async (failures) => {
        const mock = createNoFetchExpectedMock();
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await request(port, {
            method: 'OPTIONS',
            path: '/api/parse-url',
            headers: {
              Origin: 'https://allowed.example',
              'Access-Control-Request-Method': 'POST',
              'Access-Control-Request-Headers': 'Content-Type',
            },
          });
        } finally {
          global.fetch = originalFetch;
        }

        if (response.status !== 204) {
          failures.push(`expected HTTP 204, got HTTP ${response.status}`);
        }
        if (response.headers['access-control-allow-origin'] !== 'https://allowed.example') {
          failures.push(
            `expected access-control-allow-origin=https://allowed.example, got ${response.headers['access-control-allow-origin']}`
          );
        }
        if (!includesCaseInsensitive(response.headers['access-control-allow-methods'], 'POST')) {
          failures.push(
            `expected access-control-allow-methods to include POST, got ${response.headers['access-control-allow-methods']}`
          );
        }
        if (!includesCaseInsensitive(response.headers['access-control-allow-headers'], 'content-type')) {
          failures.push(
            `expected access-control-allow-headers to include content-type, got ${response.headers['access-control-allow-headers']}`
          );
        }
        if (mock.getCalls() !== 0) {
          failures.push(`expected upstream fetch calls=0, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Blocks CORS preflight for disallowed origin',
      run: async (failures) => {
        const mock = createNoFetchExpectedMock();
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await request(port, {
            method: 'OPTIONS',
            path: '/api/parse-url',
            headers: {
              Origin: 'https://evil.example',
              'Access-Control-Request-Method': 'POST',
            },
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(response.body);
        if (response.status !== 403) {
          failures.push(`expected HTTP 403, got HTTP ${response.status}`);
        }
        if (!String(body?.error ?? '').includes('Origin not allowed')) {
          failures.push(`expected origin-block error message, got "${body?.error ?? response.body}"`);
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
      description: 'Allows same-origin requests even when origin is not explicitly configured',
      run: async (failures) => {
        const mock = createStaticFetchMock(() => new Response(SUBJECTS_HTML, { status: 200 }));
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          const sameOrigin = `http://127.0.0.1:${port}`;
          response = await request(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
            headers: { Origin: sameOrigin },
          });
        } finally {
          global.fetch = originalFetch;
        }

        if (response.status !== 200) {
          failures.push(`expected HTTP 200, got HTTP ${response.status}`);
        }
        if (response.headers['access-control-allow-origin'] !== `http://127.0.0.1:${port}`) {
          failures.push(
            `expected access-control-allow-origin=http://127.0.0.1:${port}, got ${response.headers['access-control-allow-origin']}`
          );
        }
        if (mock.getCalls() !== 1) {
          failures.push(`expected upstream fetch calls=1, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Allows requests without Origin header (non-browser clients)',
      run: async (failures) => {
        const mock = createStaticFetchMock(() => new Response(SUBJECTS_HTML, { status: 200 }));
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

        if (response.status !== 200) {
          failures.push(`expected HTTP 200, got HTTP ${response.status}`);
        }
        if (response.headers['access-control-allow-origin']) {
          failures.push(`expected no access-control-allow-origin header, got ${response.headers['access-control-allow-origin']}`);
        }
        if (mock.getCalls() !== 1) {
          failures.push(`expected upstream fetch calls=1, got ${mock.getCalls()}`);
        }
      },
    },
  ];

  let passed = 0;
  try {
    for (const test of tests) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await runSingleTest(test);
      if (ok) {
        passed += 1;
      }
    }
  } finally {
    await stopInMemoryServer(server);
  }

  const failed = tests.length - passed;
  console.log(`\nSummary: ${passed}/${tests.length} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(`Fatal test runner error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
