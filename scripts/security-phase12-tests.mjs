#!/usr/bin/env node

import http from 'node:http';

process.env.NO_SERVER = '1';
process.env.NODE_ENV = 'production';
process.env.TRUST_PROXY = '0';
process.env.LOG_API_ERROR_DETAILS = '0';
process.env.API_RATE_LIMIT_WINDOW_MS = '60000';
process.env.API_RATE_LIMIT_PARSE_MAX = '100';
process.env.API_RATE_LIMIT_SUBJECTS_MAX = '100';
process.env.UPSTREAM_FETCH_TIMEOUT_MS = '5000';
process.env.UPSTREAM_MAX_RESPONSE_BYTES = '2097152';

const { app } = await import('../server/index.js');

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

function captureConsoleErrors() {
  const logs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => {
    logs.push(args.map((value) => String(value)).join(' '));
  };
  return {
    logs,
    restore: () => {
      console.error = originalConsoleError;
    },
  };
}

function assertRedactedLog(logs, secret, failures, label) {
  const logLine = [...logs].reverse().find((line) => line.includes('"event":"api_request_failed"'));
  if (!logLine) {
    failures.push(`${label}: expected structured api_request_failed log line`);
    return;
  }
  if (logLine.includes(secret)) {
    failures.push(`${label}: secret value appeared in error log output`);
    return;
  }

  let parsedLog;
  try {
    parsedLog = JSON.parse(logLine);
  } catch {
    failures.push(`${label}: failed to parse JSON log payload`);
    return;
  }

  if (String(parsedLog?.error?.message ?? '') !== 'redacted') {
    failures.push(`${label}: expected error.message=redacted, got "${parsedLog?.error?.message}"`);
  }
  if (Object.prototype.hasOwnProperty.call(parsedLog?.error ?? {}, 'stack')) {
    failures.push(`${label}: expected stack to be omitted in redacted production logs`);
  }
}

async function run() {
  const { server, port } = await startInMemoryServer();
  const tests = [
    {
      description: 'Production log redaction hides sensitive subjects-route failure details',
      run: async (failures) => {
        const secret = 'phase12-subjects-secret';
        const mock = createThrowingFetchMock(() => new Error(secret));
        const originalFetch = global.fetch;
        const capture = captureConsoleErrors();
        global.fetch = mock.fetch;
        let response;

        try {
          response = await request(port, {
            method: 'GET',
            path: '/api/subjects?campId=1&termId=202601',
          });
        } finally {
          global.fetch = originalFetch;
          capture.restore();
        }

        const body = safeJsonParse(response.body);
        if (response.status !== 500) {
          failures.push(`expected HTTP 500, got HTTP ${response.status}`);
        }
        if (String(body?.error ?? '') !== 'Internal server error.') {
          failures.push(`expected redacted response error message, got "${body?.error ?? response.body}"`);
        }
        assertRedactedLog(capture.logs, secret, failures, 'subjects');
        if (mock.getCalls() !== 1) {
          failures.push(`expected upstream fetch calls=1, got ${mock.getCalls()}`);
        }
      },
    },
    {
      description: 'Production log redaction hides sensitive parse-route failure details',
      run: async (failures) => {
        const secret = 'phase12-parse-secret';
        const mock = createThrowingFetchMock(() => new Error(secret));
        const originalFetch = global.fetch;
        const capture = captureConsoleErrors();
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
          capture.restore();
        }

        const body = safeJsonParse(response.body);
        if (response.status !== 500) {
          failures.push(`expected HTTP 500, got HTTP ${response.status}`);
        }
        if (String(body?.error ?? '') !== 'Internal server error.') {
          failures.push(`expected redacted response error message, got "${body?.error ?? response.body}"`);
        }
        assertRedactedLog(capture.logs, secret, failures, 'parse-url');
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
