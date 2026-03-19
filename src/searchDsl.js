function clampWildcardDigits(rawDigits) {
  const normalized = String(rawDigits || '').trim();
  if (!/^\d{1,4}$/.test(normalized)) {
    return null;
  }

  const power = 4 - normalized.length;
  const base = Number.parseInt(normalized, 10);
  const lower = base * 10 ** power;
  const upper = lower + 10 ** power - 1;
  return { lower, upper };
}

function parseNumericToken(token) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) {
    return null;
  }

  const rangeMatch = normalizedToken.match(/^(\d{1,4})\*-(\d{1,4})\*$/);
  if (rangeMatch) {
    const lowerBounds = clampWildcardDigits(rangeMatch[1]);
    const upperBounds = clampWildcardDigits(rangeMatch[2]);
    if (!lowerBounds || !upperBounds) {
      return null;
    }
    return {
      kind: 'numeric-range',
      min: Math.min(lowerBounds.lower, upperBounds.lower),
      max: Math.max(lowerBounds.upper, upperBounds.upper),
    };
  }

  const plusMatch = normalizedToken.match(/^(\d{1,4})\+$/);
  if (plusMatch) {
    const bounds = clampWildcardDigits(plusMatch[1]);
    if (!bounds) {
      return null;
    }
    return {
      kind: 'numeric-comparator',
      operator: 'gte',
      value: bounds.lower,
    };
  }

  const wildcardComparatorMatch = normalizedToken.match(/^(<=|>=|<|>)(\d{1,4})\*$/);
  if (wildcardComparatorMatch) {
    const operator = wildcardComparatorMatch[1];
    const bounds = clampWildcardDigits(wildcardComparatorMatch[2]);
    if (!bounds) {
      return null;
    }

    if (operator === '<') {
      return { kind: 'numeric-comparator', operator: 'lt', value: bounds.lower };
    }
    if (operator === '<=') {
      return { kind: 'numeric-comparator', operator: 'lte', value: bounds.upper };
    }
    if (operator === '>') {
      return { kind: 'numeric-comparator', operator: 'gt', value: bounds.upper };
    }
    return { kind: 'numeric-comparator', operator: 'gte', value: bounds.lower };
  }

  const strictComparatorMatch = normalizedToken.match(/^(<=|>=|<|>)(\d{1,4})$/);
  if (strictComparatorMatch) {
    const operator = strictComparatorMatch[1];
    const numericValue = Number.parseInt(strictComparatorMatch[2], 10);
    if (Number.isNaN(numericValue)) {
      return null;
    }

    return {
      kind: 'numeric-comparator',
      operator: operator === '<' ? 'lt' : operator === '<=' ? 'lte' : operator === '>' ? 'gt' : 'gte',
      value: numericValue,
    };
  }

  const wildcardMatch = normalizedToken.match(/^(\d{1,4})\*$/);
  if (wildcardMatch) {
    const bounds = clampWildcardDigits(wildcardMatch[1]);
    if (!bounds) {
      return null;
    }

    return {
      kind: 'numeric-range',
      min: bounds.lower,
      max: bounds.upper,
    };
  }

  return null;
}

function parseClauseTokens(rawClause) {
  const tokens = String(rawClause || '')
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const parsedTokens = [];
  let hasNumericDsl = false;

  for (const token of tokens) {
    const numericToken = parseNumericToken(token);
    if (numericToken) {
      parsedTokens.push(numericToken);
      hasNumericDsl = true;
      continue;
    }

    parsedTokens.push({ kind: 'text', value: token.toLowerCase() });
  }

  return { tokens: parsedTokens, hasNumericDsl };
}

function compareNumeric(operator, left, right) {
  if (operator === 'lt') {
    return left < right;
  }
  if (operator === 'lte') {
    return left <= right;
  }
  if (operator === 'gt') {
    return left > right;
  }
  return left >= right;
}

function matchesNumericToken(token, courseNumbers) {
  if (!Array.isArray(courseNumbers) || courseNumbers.length === 0) {
    return false;
  }

  if (token.kind === 'numeric-range') {
    return courseNumbers.some((value) => value >= token.min && value <= token.max);
  }

  if (token.kind === 'numeric-comparator') {
    return courseNumbers.some((value) => compareNumeric(token.operator, value, token.value));
  }

  return false;
}

function matchesClause(clause, searchContext) {
  const haystack = String(searchContext?.haystack || '').toLowerCase();
  const courseNumbers = Array.isArray(searchContext?.courseNumbers) ? searchContext.courseNumbers : [];

  if (!Array.isArray(clause) || clause.length === 0) {
    return false;
  }

  for (const token of clause) {
    if (token.kind === 'text') {
      if (!haystack.includes(token.value)) {
        return false;
      }
      continue;
    }

    if (!matchesNumericToken(token, courseNumbers)) {
      return false;
    }
  }

  return true;
}

export function parseCourseSearchQuery(rawQuery) {
  const query = String(rawQuery || '').trim();
  if (!query) {
    return { mode: 'empty', query: '' };
  }

  const clauseTexts = query
    .split('||')
    .map((value) => value.trim())
    .filter(Boolean);
  if (clauseTexts.length === 0) {
    return { mode: 'empty', query: '' };
  }

  const parsedClauses = clauseTexts.map((clauseText) => parseClauseTokens(clauseText));
  const hasOrJoin = clauseTexts.length > 1;
  const hasNumericDsl = parsedClauses.some((clause) => clause.hasNumericDsl);

  if (!hasOrJoin && !hasNumericDsl) {
    return { mode: 'simple', term: query.toLowerCase(), query };
  }

  return {
    mode: 'expression',
    query,
    clauses: parsedClauses
      .map((clause) => clause.tokens)
      .filter((tokens) => Array.isArray(tokens) && tokens.length > 0),
  };
}

export function matchesParsedCourseSearchQuery(parsedQuery, searchContext) {
  if (!parsedQuery || parsedQuery.mode === 'empty') {
    return true;
  }

  const haystack = String(searchContext?.haystack || '').toLowerCase();
  if (parsedQuery.mode === 'simple') {
    return haystack.includes(String(parsedQuery.term || '').toLowerCase());
  }

  if (!Array.isArray(parsedQuery.clauses) || parsedQuery.clauses.length === 0) {
    return false;
  }

  return parsedQuery.clauses.some((clause) => matchesClause(clause, searchContext));
}

export function extractNormalizedCourseNumbers(course) {
  const values = [];

  values.push(String(course?.courseNumber || ''));
  if (Array.isArray(course?.registrationDetails)) {
    for (const detail of course.registrationDetails) {
      values.push(String(detail?.courseNumber || ''));
    }
  }

  const numbers = new Set();
  const pattern = /(\d{4})[A-Za-z]?/g;

  for (const value of values) {
    let match;
    while ((match = pattern.exec(value)) !== null) {
      const parsed = Number.parseInt(match[1], 10);
      if (!Number.isNaN(parsed)) {
        numbers.add(parsed);
      }
    }
  }

  return [...numbers].sort((left, right) => left - right);
}
