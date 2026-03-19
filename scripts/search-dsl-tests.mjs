#!/usr/bin/env node

import {
  extractNormalizedCourseNumbers,
  matchesParsedCourseSearchQuery,
  parseCourseSearchQuery,
} from '../src/searchDsl.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runCase(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${name}`);
    console.log(`  - ${message}`);
    process.exitCode = 1;
  }
}

function buildContext(courseNumber, haystackText = '') {
  const course = {
    courseNumber,
    registrationDetails: [{ courseNumber }],
  };
  return {
    course,
    haystack: String(haystackText || courseNumber).toLowerCase(),
    courseNumbers: extractNormalizedCourseNumbers(course),
  };
}

function matches(query, context) {
  const parsed = parseCourseSearchQuery(query);
  return matchesParsedCourseSearchQuery(parsed, {
    haystack: context.haystack,
    courseNumbers: context.courseNumbers,
  });
}

runCase('Wildcard range 1*-4* includes undergraduate and excludes graduate', () => {
  assert(matches('1*-4*', buildContext('CSCI 2401W')), 'Expected 2401W to match 1*-4*.');
  assert(matches('1*-4*', buildContext('CSCI 4999')), 'Expected 4999 to match 1*-4*.');
  assert(!matches('1*-4*', buildContext('CSCI 6001')), 'Expected 6001 to not match 1*-4*.');
});

runCase('Prefix wildcard and plus operators work', () => {
  assert(matches('6*', buildContext('CSCI 6205')), 'Expected 6205 to match 6*.');
  assert(matches('62*', buildContext('CSCI 6205')), 'Expected 6205 to match 62*.');
  assert(!matches('62*', buildContext('CSCI 6105')), 'Expected 6105 to not match 62*.');
  assert(matches('62+', buildContext('CSCI 6200')), 'Expected 6200 to match 62+.');
  assert(matches('62+', buildContext('CSCI 8300')), 'Expected 8300 to match 62+.');
  assert(!matches('62+', buildContext('CSCI 6100')), 'Expected 6100 to not match 62+.');
});

runCase('Level-aware comparators on wildcard bands work', () => {
  assert(matches('<3*', buildContext('CSCI 2999')), 'Expected 2999 to match <3*.');
  assert(!matches('<3*', buildContext('CSCI 3000')), 'Expected 3000 to not match <3*.');
  assert(matches('<=3*', buildContext('CSCI 3999')), 'Expected 3999 to match <=3*.');
  assert(!matches('<=3*', buildContext('CSCI 4000')), 'Expected 4000 to not match <=3*.');
  assert(matches('>6*', buildContext('CSCI 7000')), 'Expected 7000 to match >6*.');
  assert(!matches('>6*', buildContext('CSCI 6999')), 'Expected 6999 to not match >6*.');
  assert(matches('>=6*', buildContext('CSCI 6000')), 'Expected 6000 to match >=6*.');
});

runCase('OR join (||) and AND-by-space behavior works', () => {
  const ai6200 = buildContext('CSCI 6212', 'csci 6212 machine learning taylor');
  const phd8000 = buildContext('CSCI 8210', 'csci 8210 research methods');
  const unrelated = buildContext('CSCI 5001', 'csci 5001 special topics');

  assert(matches('62* || 8*', ai6200), 'Expected 6212 to match 62* || 8*.');
  assert(matches('62* || 8*', phd8000), 'Expected 8210 to match 62* || 8*.');
  assert(!matches('62* || 8*', unrelated), 'Expected 5001 to not match 62* || 8*.');

  assert(matches('62* machine', ai6200), 'Expected 62* AND machine text to match.');
  assert(!matches('62* systems', ai6200), 'Expected missing text token to fail AND clause.');
});

runCase('Suffix-insensitive extraction includes 2401W as 2401', () => {
  const parsed = extractNormalizedCourseNumbers({
    courseNumber: 'CSCI 2401W / CSCI 6401',
    registrationDetails: [{ courseNumber: 'CSCI 2401W' }, { courseNumber: 'CSCI 6401' }],
  });

  assert(parsed.includes(2401), 'Expected extraction to include 2401 from 2401W.');
  assert(parsed.includes(6401), 'Expected extraction to include 6401.');
  assert(matches('24*', buildContext('CSCI 2401W')), 'Expected 2401W to match 24*.');
});

runCase('Invalid DSL-like token safely falls back to plain text matching', () => {
  const context = buildContext('CSCI 6220', 'csci 6220 advanced topics');
  assert(matches('6**', context) === false, 'Expected invalid token fallback to not match unrelated text by default.');
  assert(matches('advanced', context), 'Expected plain text search to still work.');
});

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}

console.log('PASS Search DSL tests completed successfully.');
