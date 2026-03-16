#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BASE_TAG_PATTERN = /^v(\d+)\.(\d+)$/;

function runGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    return null;
  }
  return String(result.stdout || '').trim();
}

function isAncestor(tagName) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', tagName, 'HEAD']);
  return result.status === 0;
}

function compareBaseTags(leftTag, rightTag) {
  const leftMatch = leftTag.match(BASE_TAG_PATTERN);
  const rightMatch = rightTag.match(BASE_TAG_PATTERN);
  if (!leftMatch || !rightMatch) {
    return 0;
  }

  const leftMajor = Number.parseInt(leftMatch[1], 10);
  const leftMinor = Number.parseInt(leftMatch[2], 10);
  const rightMajor = Number.parseInt(rightMatch[1], 10);
  const rightMinor = Number.parseInt(rightMatch[2], 10);

  if (leftMajor !== rightMajor) {
    return leftMajor - rightMajor;
  }
  return leftMinor - rightMinor;
}

function resolveBaseTag() {
  const envBaseTag = String(process.env.APP_VERSION_BASE_TAG ?? '').trim();
  if (envBaseTag) {
    if (BASE_TAG_PATTERN.test(envBaseTag) && isAncestor(envBaseTag)) {
      return envBaseTag;
    }
    return '';
  }

  const rawTags = runGit(['tag', '--list']);
  if (!rawTags) {
    return '';
  }

  const tags = rawTags
    .split('\n')
    .map((tag) => tag.trim())
    .filter((tag) => BASE_TAG_PATTERN.test(tag))
    .filter((tag) => isAncestor(tag))
    .sort(compareBaseTags);

  return tags.at(-1) ?? '';
}

function commitCountSince(baseTag) {
  if (!baseTag) {
    return 0;
  }
  const countText = runGit(['rev-list', '--count', `${baseTag}..HEAD`]);
  const parsed = Number.parseInt(String(countText ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function computeAppVersion() {
  const explicitVersion = String(process.env.VITE_APP_VERSION ?? '').trim();
  if (explicitVersion) {
    return explicitVersion;
  }

  const baseTag = resolveBaseTag();
  if (!baseTag) {
    return 'v0.1-dev';
  }

  const count = commitCountSince(baseTag);
  if (count === 0) {
    return baseTag;
  }

  return `${baseTag}.${count}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // eslint-disable-next-line no-console
  console.log(computeAppVersion());
}
