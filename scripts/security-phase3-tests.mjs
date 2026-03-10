#!/usr/bin/env node

import http from 'node:http';

process.env.NO_SERVER = '1';
process.env.UPSTREAM_FETCH_TIMEOUT_MS = '40';
process.env.UPSTREAM_MAX_RESPONSE_BYTES = '1024';
process.env.API_RATE_LIMIT_WINDOW_MS = '60000';
process.env.API_RATE_LIMIT_PARSE_MAX = '2';
process.env.API_RATE_LIMIT_SUBJECTS_MAX = '2';
process.env.TRUST_PROXY = '1';

const { app } = await import('../server/index.js');

const EMPTY_HTML = '<!doctype html><html><body><table></table></body></html>';
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

function createTimeoutFetchMock() {
  let calls = 0;
  return {
    fetch: async (_url, options = {}) => {
      calls += 1;
      const signal = options.signal;
      return new Promise((_, reject) => {
        if (!signal) {
          reject(new Error('Expected fetch signal for timeout test.'));
          return;
        }
        const abort = () => reject(signal.reason ?? new Error('aborted'));
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
      });
    },
    getCalls: () => calls,
  };
}

function requestJson(port, { method, path, payload = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const body = payload == null ? '' : JSON.stringify(payload);
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
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
            headers: response.headers,
          });
        });
      }
    );

    request.on('error', reject);
    if (payload != null) {
      request.write(body);
    }
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
      description: 'Timeout returns 504 for /api/parse-url',
      run: async (failures) => {
        const mock = createTimeoutFetchMock();
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await requestJson(port, {
            method: 'POST',
            path: '/api/parse-url',
            headers: { 'x-forwarded-for': '198.51.100.11' },
            payload: {
              url: 'https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI',
            },
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(response.body);
        if (response.status !== 504) {
          failures.push(`expected HTTP 504, got HTTP ${response.status}`);
        }
        if (!String(body?.error ?? '').includes('timed out')) {
          failures.push(`expected timeout error message, got "${body?.error ?? response.body}"`);
        }
        if (mock.getCalls() !== 1) {
          failures.push(`expected upstream fetch calls=1, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Timeout returns 504 for /api/subjects',
      run: async (failures) => {
        const mock = createTimeoutFetchMock();
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await requestJson(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
            headers: { 'x-forwarded-for': '198.51.100.12' },
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(response.body);
        if (response.status !== 504) {
          failures.push(`expected HTTP 504, got HTTP ${response.status}`);
        }
        if (!String(body?.error ?? '').includes('timed out')) {
          failures.push(`expected timeout error message, got "${body?.error ?? response.body}"`);
        }
        if (mock.getCalls() !== 1) {
          failures.push(`expected upstream fetch calls=1, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Oversized upstream body returns 502 for /api/parse-url',
      run: async (failures) => {
        const largeBody = '<html><body>' + 'X'.repeat(3000) + '</body></html>';
        const mock = createStaticFetchMock(() => new Response(largeBody, { status: 200 }));
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await requestJson(port, {
            method: 'POST',
            path: '/api/parse-url',
            headers: { 'x-forwarded-for': '198.51.100.13' },
            payload: {
              url: 'https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI',
            },
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(response.body);
        if (response.status !== 502) {
          failures.push(`expected HTTP 502, got HTTP ${response.status}`);
        }
        if (!String(body?.error ?? '').includes('exceeded 1024 bytes')) {
          failures.push(`expected size-limit error message, got "${body?.error ?? response.body}"`);
        }
        if (mock.getCalls() !== 1) {
          failures.push(`expected upstream fetch calls=1, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Oversized upstream body returns 502 for /api/subjects',
      run: async (failures) => {
        const largeBody = '<html><body>' + 'Y'.repeat(3000) + '</body></html>';
        const mock = createStaticFetchMock(() => new Response(largeBody, { status: 200 }));
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let response;

        try {
          response = await requestJson(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
            headers: { 'x-forwarded-for': '198.51.100.14' },
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(response.body);
        if (response.status !== 502) {
          failures.push(`expected HTTP 502, got HTTP ${response.status}`);
        }
        if (!String(body?.error ?? '').includes('exceeded 1024 bytes')) {
          failures.push(`expected size-limit error message, got "${body?.error ?? response.body}"`);
        }
        if (mock.getCalls() !== 1) {
          failures.push(`expected upstream fetch calls=1, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Rate limiter blocks /api/parse-url after configured threshold',
      run: async (failures) => {
        const mock = createStaticFetchMock(() => new Response(EMPTY_HTML, { status: 200 }));
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let first;
        let second;
        let third;

        try {
          const headers = { 'x-forwarded-for': '198.51.100.15' };
          const payload = {
            url: 'https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI',
          };
          first = await requestJson(port, { method: 'POST', path: '/api/parse-url', headers, payload });
          second = await requestJson(port, { method: 'POST', path: '/api/parse-url', headers, payload });
          third = await requestJson(port, { method: 'POST', path: '/api/parse-url', headers, payload });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(third.body);
        if (first.status !== 422 || second.status !== 422) {
          failures.push(`expected first two statuses to be 422/422, got ${first.status}/${second.status}`);
        }
        if (third.status !== 429) {
          failures.push(`expected third status HTTP 429, got HTTP ${third.status}`);
        }
        if (!String(body?.error ?? '').includes('Rate limit exceeded for /api/parse-url')) {
          failures.push(`expected parse rate-limit error, got "${body?.error ?? third.body}"`);
        }
        if (!third.headers['retry-after']) {
          failures.push('expected Retry-After header on 429 response');
        }
        if (mock.getCalls() !== 2) {
          failures.push(`expected upstream fetch calls=2 before limit, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Rate limiter blocks /api/subjects after configured threshold',
      run: async (failures) => {
        const mock = createStaticFetchMock(() => new Response(SUBJECTS_HTML, { status: 200 }));
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let first;
        let second;
        let third;

        try {
          const headers = { 'x-forwarded-for': '198.51.100.16' };
          const path = '/api/subjects?campId=1&termId=202601';
          first = await requestJson(port, { method: 'GET', path, headers });
          second = await requestJson(port, { method: 'GET', path, headers });
          third = await requestJson(port, { method: 'GET', path, headers });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(third.body);
        if (first.status !== 200 || second.status !== 200) {
          failures.push(`expected first two statuses to be 200/200, got ${first.status}/${second.status}`);
        }
        if (third.status !== 429) {
          failures.push(`expected third status HTTP 429, got HTTP ${third.status}`);
        }
        if (!String(body?.error ?? '').includes('Rate limit exceeded for /api/subjects')) {
          failures.push(`expected subjects rate-limit error, got "${body?.error ?? third.body}"`);
        }
        if (!third.headers['retry-after']) {
          failures.push('expected Retry-After header on 429 response');
        }
        if (mock.getCalls() !== 2) {
          failures.push(`expected upstream fetch calls=2 before limit, got ${mock.getCalls()}`);
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
