#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BASE_TAG_PATTERN = /^v(\d+)\.(\d+)$/;

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    timeout: Number.parseInt(String(process.env.APP_VERSION_GIT_TIMEOUT_MS ?? '15000'), 10) || 15000,
  });
  if (result.status !== 0) {
    return options.allowFailure ? '' : null;
  }
  return String(result.stdout || '').trim();
}

function isInsideGitWorkTree() {
  return runGit(['rev-parse', '--is-inside-work-tree']) === 'true';
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

function listCandidateBaseTags() {
  const rawTags = runGit(['tag', '--list']);
  if (!rawTags) {
    return [];
  }

  return rawTags
    .split('\n')
    .map((tag) => tag.trim())
    .filter((tag) => BASE_TAG_PATTERN.test(tag))
    .filter((tag) => isAncestor(tag))
    .sort(compareBaseTags);
}

function tryHydrateGitHistoryForVersioning() {
  if (String(process.env.APP_VERSION_SKIP_GIT_FETCH ?? '') === '1') {
    return;
  }
  if (!isInsideGitWorkTree()) {
    return;
  }

  const isShallow = runGit(['rev-parse', '--is-shallow-repository']) === 'true';

  if (isShallow) {
    runGit(['fetch', '--unshallow', '--tags', '--force', '--prune'], { allowFailure: true });
    runGit(['fetch', '--depth=5000', '--tags', '--force', '--prune'], { allowFailure: true });
    return;
  }

  runGit(['fetch', '--tags', '--force', '--prune'], { allowFailure: true });
}

function resolveBaseTag() {
  const envBaseTag = String(process.env.APP_VERSION_BASE_TAG ?? '').trim();
  if (envBaseTag) {
    if (!BASE_TAG_PATTERN.test(envBaseTag)) {
      return '';
    }
    if (isAncestor(envBaseTag)) {
      return envBaseTag;
    }
    tryHydrateGitHistoryForVersioning();
    if (isAncestor(envBaseTag)) {
      return envBaseTag;
    }
    // In hosted builds that strip git metadata, keep the declared base tag
    // instead of falling all the way back to a generic -dev label.
    return envBaseTag;
  }

  let tags = listCandidateBaseTags();
  if (tags.length > 0) {
    return tags.at(-1) ?? '';
  }

  tryHydrateGitHistoryForVersioning();
  tags = listCandidateBaseTags();

  return tags.at(-1) ?? '';
}

function normalizeBuildHash(rawValue) {
  const text = String(rawValue ?? '').trim();
  if (!text) {
    return '';
  }

  const match = text.match(/[a-f0-9]{7,40}/i);
  if (!match) {
    return '';
  }

  return match[0].slice(0, 7).toLowerCase();
}

function normalizeBuildNumber(rawValue) {
  const text = String(rawValue ?? '').trim();
  if (!text) {
    return '';
  }

  const cleaned = text.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!cleaned) {
    return '';
  }

  return cleaned.slice(0, 16);
}

function resolveBuildHash() {
  const envCandidates = [
    process.env.APP_BUILD_SHA,
    process.env.VITE_GIT_SHA,
    process.env.GITHUB_SHA,
    process.env.COMMIT_SHA,
    process.env.SOURCE_VERSION,
    process.env.REVISION_ID,
  ];

  for (const candidate of envCandidates) {
    const hash = normalizeBuildHash(candidate);
    if (hash) {
      return hash;
    }
  }

  let gitHash = normalizeBuildHash(runGit(['rev-parse', '--short=7', 'HEAD']));
  if (gitHash) {
    return gitHash;
  }

  tryHydrateGitHistoryForVersioning();
  gitHash = normalizeBuildHash(runGit(['rev-parse', '--short=7', 'HEAD']));
  return gitHash;
}

function resolveBuildNumber() {
  const envCandidates = [
    process.env.APP_BUILD_NUMBER,
    process.env.VITE_BUILD_NUMBER,
    process.env.FIREBASE_BUILD_NUMBER,
    process.env.GITHUB_RUN_NUMBER,
    process.env.BUILD_ID,
    process.env.GOOGLE_CLOUD_BUILD_ID,
    process.env.CLOUD_BUILD_ID,
    process.env.X_FIREBASE_APPHOSTING_BUILD_ID,
  ];

  for (const candidate of envCandidates) {
    const normalized = normalizeBuildNumber(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

export function computeAppVersion() {
  const explicitVersion = String(process.env.VITE_APP_VERSION ?? '').trim();
  if (explicitVersion) {
    return explicitVersion;
  }

  const baseTag = resolveBaseTag() || 'v0.2';
  const buildHash = resolveBuildHash() || 'unknown';
  const buildNumber = resolveBuildNumber();
  const hashVersion = `${baseTag}-Build-${buildHash}`;
  if (buildNumber) {
    return `${hashVersion}-N${buildNumber}`;
  }
  return hashVersion;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // eslint-disable-next-line no-console
  console.log(computeAppVersion());
}
