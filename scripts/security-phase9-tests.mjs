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

const EMPTY_HTML = '<!doctype html><html><body><table></table></body></html>';

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

function request(port, { method, path, headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(body
            ? {
                'Content-Length': Buffer.byteLength(body),
              }
            : {}),
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
            headers: res.headers,
            body: rawBody,
          });
        });
      }
    );

    req.on('error', reject);
    if (body) {
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

function assertApiHeaders(response, failures, label) {
  const requestIdHeader = String(response.headers['x-request-id'] ?? '');
  if (!requestIdHeader) {
    failures.push(`${label}: expected x-request-id header`);
  }
  if (!String(response.headers['cache-control'] ?? '').includes('no-store')) {
    failures.push(`${label}: expected cache-control to include no-store`);
  }
  if (String(response.headers.pragma ?? '').toLowerCase() !== 'no-cache') {
    failures.push(`${label}: expected pragma=no-cache`);
  }
  if (!String(response.headers['content-type'] ?? '').includes('application/json')) {
    failures.push(`${label}: expected application/json content-type`);
  }
  return requestIdHeader;
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
      description: 'Malformed JSON returns hardened 400 API JSON response',
      run: async (failures) => {
        const mock = createNoFetchExpectedMock();
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await request(port, {
            method: 'POST',
            path: '/api/parse-url',
            headers: { 'Content-Type': 'application/json' },
            body: '{"url":"https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI"',
          });
        } finally {
          global.fetch = originalFetch;
        }

        const parsed = safeJsonParse(response.body);
        const requestIdHeader = assertApiHeaders(response, failures, 'malformed-json');
        if (response.status !== 400) {
          failures.push(`expected HTTP 400, got HTTP ${response.status}`);
        }
        if (String(parsed?.error ?? '') !== 'Malformed JSON request body.') {
          failures.push(`expected malformed-json message, got "${parsed?.error ?? response.body}"`);
        }
        if (String(parsed?.requestId ?? '') !== requestIdHeader) {
          failures.push(
            `expected response body requestId to match x-request-id header (${requestIdHeader}), got ${parsed?.requestId}`
          );
        }
        if (mock.getCalls() !== 0) {
          failures.push(`expected upstream fetch calls=0, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Oversized JSON body returns hardened 413 API JSON response',
      run: async (failures) => {
        const mock = createNoFetchExpectedMock();
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          const oversizedSubject = 'A'.repeat(1024 * 1024);
          const body = JSON.stringify({
            url: `https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=${oversizedSubject}`,
          });
          response = await request(port, {
            method: 'POST',
            path: '/api/parse-url',
            headers: { 'Content-Type': 'application/json' },
            body,
          });
        } finally {
          global.fetch = originalFetch;
        }

        const parsed = safeJsonParse(response.body);
        const requestIdHeader = assertApiHeaders(response, failures, 'oversized-json');
        if (response.status !== 413) {
          failures.push(`expected HTTP 413, got HTTP ${response.status}`);
        }
        if (String(parsed?.error ?? '') !== 'Request body exceeds the 1mb JSON limit.') {
          failures.push(`expected oversized-body message, got "${parsed?.error ?? response.body}"`);
        }
        if (String(parsed?.requestId ?? '') !== requestIdHeader) {
          failures.push(
            `expected response body requestId to match x-request-id header (${requestIdHeader}), got ${parsed?.requestId}`
          );
        }
        if (mock.getCalls() !== 0) {
          failures.push(`expected upstream fetch calls=0, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Normal request validation remains unchanged after parser hardening',
      run: async (failures) => {
        const mock = createNoFetchExpectedMock();
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await request(port, {
            method: 'POST',
            path: '/api/parse-url',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: 'https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=bad&subjId=CSCI',
            }),
          });
        } finally {
          global.fetch = originalFetch;
        }

        const parsed = safeJsonParse(response.body);
        const requestIdHeader = assertApiHeaders(response, failures, 'validation');
        if (response.status !== 400) {
          failures.push(`expected HTTP 400, got HTTP ${response.status}`);
        }
        if (!String(parsed?.error ?? '').includes('termId must be a 6-digit numeric value.')) {
          failures.push(`expected termId validation message, got "${parsed?.error ?? response.body}"`);
        }
        if (String(parsed?.requestId ?? '') !== requestIdHeader) {
          failures.push(
            `expected response body requestId to match x-request-id header (${requestIdHeader}), got ${parsed?.requestId}`
          );
        }
        if (mock.getCalls() !== 0) {
          failures.push(`expected upstream fetch calls=0, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Successful parsing path still functions with upstream fetch',
      run: async (failures) => {
        const mock = createStaticFetchMock(() => new Response(EMPTY_HTML, { status: 200 }));
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await request(port, {
            method: 'POST',
            path: '/api/parse-url',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: 'https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI',
            }),
          });
        } finally {
          global.fetch = originalFetch;
        }

        const parsed = safeJsonParse(response.body);
        const requestIdHeader = assertApiHeaders(response, failures, 'success-path');
        if (response.status !== 422) {
          failures.push(`expected HTTP 422, got HTTP ${response.status}`);
        }
        if (!String(parsed?.error ?? '').includes('No classes are currently published')) {
          failures.push(`expected no-classes message, got "${parsed?.error ?? response.body}"`);
        }
        if (String(parsed?.requestId ?? '') !== requestIdHeader) {
          failures.push(
            `expected response body requestId to match x-request-id header (${requestIdHeader}), got ${parsed?.requestId}`
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
