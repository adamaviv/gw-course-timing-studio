#!/usr/bin/env node

import http from 'node:http';

process.env.NO_SERVER = '1';
process.env.NODE_ENV = 'production';
process.env.TRUST_PROXY = '0';
process.env.API_RATE_LIMIT_WINDOW_MS = '60000';
process.env.API_RATE_LIMIT_PARSE_MAX = '2';
process.env.API_RATE_LIMIT_SUBJECTS_MAX = '2';
process.env.API_RATE_LIMIT_BUCKET_CAP = '200';
process.env.UPSTREAM_FETCH_TIMEOUT_MS = '5000';
process.env.UPSTREAM_MAX_RESPONSE_BYTES = '2097152';

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

async function run() {
  const { server, port } = await startInMemoryServer();

  const tests = [
    {
      description: 'Removes x-powered-by framework header',
      run: async (failures) => {
        let response;

        response = await request(port, {
          method: 'GET',
          path: '/phase5-nonexistent-route',
        });

        if (response.status !== 404) {
          failures.push(`expected HTTP 404, got HTTP ${response.status}`);
        }
        if (response.headers['x-powered-by']) {
          failures.push(`expected no x-powered-by header, got ${response.headers['x-powered-by']}`);
        }
      },
    },
    {
      description: 'Ignores spoofed x-forwarded-for when rate limiting /api/parse-url with TRUST_PROXY disabled',
      run: async (failures) => {
        const mock = createStaticFetchMock(() => new Response(EMPTY_HTML, { status: 200 }));
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let first;
        let second;
        let third;

        try {
          const payload = {
            url: 'https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI',
          };
          first = await request(port, {
            method: 'POST',
            path: '/api/parse-url',
            headers: { 'x-forwarded-for': '198.51.100.10' },
            payload,
          });
          second = await request(port, {
            method: 'POST',
            path: '/api/parse-url',
            headers: { 'x-forwarded-for': '198.51.100.11' },
            payload,
          });
          third = await request(port, {
            method: 'POST',
            path: '/api/parse-url',
            headers: { 'x-forwarded-for': '198.51.100.12' },
            payload,
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(third.body);
        if (first.status !== 422 || second.status !== 422) {
          failures.push(`expected first two statuses 422/422, got ${first.status}/${second.status}`);
        }
        if (third.status !== 429) {
          failures.push(`expected third status HTTP 429, got HTTP ${third.status}`);
        }
        if (!String(body?.error ?? '').includes('Rate limit exceeded for /api/parse-url')) {
          failures.push(`expected parse-url rate-limit error, got "${body?.error ?? third.body}"`);
        }
        if (mock.getCalls() !== 2) {
          failures.push(`expected upstream fetch calls=2 before limiter block, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Ignores spoofed x-forwarded-for when rate limiting /api/subjects with TRUST_PROXY disabled',
      run: async (failures) => {
        const mock = createStaticFetchMock(() => new Response(SUBJECTS_HTML, { status: 200 }));
        const originalFetch = global.fetch;
        global.fetch = mock.fetch;
        let first;
        let second;
        let third;

        try {
          first = await request(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
            headers: { 'x-forwarded-for': '198.51.100.20' },
          });
          second = await request(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
            headers: { 'x-forwarded-for': '198.51.100.21' },
          });
          third = await request(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
            headers: { 'x-forwarded-for': '198.51.100.22' },
          });
        } finally {
          global.fetch = originalFetch;
        }

        const body = safeJsonParse(third.body);
        if (first.status !== 200 || second.status !== 200) {
          failures.push(`expected first two statuses 200/200, got ${first.status}/${second.status}`);
        }
        if (third.status !== 429) {
          failures.push(`expected third status HTTP 429, got HTTP ${third.status}`);
        }
        if (!String(body?.error ?? '').includes('Rate limit exceeded for /api/subjects')) {
          failures.push(`expected subjects rate-limit error, got "${body?.error ?? third.body}"`);
        }
        if (mock.getCalls() !== 2) {
          failures.push(`expected upstream fetch calls=2 before limiter block, got ${mock.getCalls()}`);
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
