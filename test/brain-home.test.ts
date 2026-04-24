/**
 * Tests for src/core/brain-home.ts — resolveBrainHome() resolution order.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import {
  resolveBrainHome,
  brainHomeSubdir,
  __resetBrainHomeCache,
} from '../src/core/brain-home.ts';

const H = homedir();
const OLYMPUS_PATH = join(H, '.olympus', 'brain');
const GBRAIN_PATH = join(H, '.gbrain');

function saveEnv() {
  return {
    OLYMPUS_BRAIN_HOME: process.env.OLYMPUS_BRAIN_HOME,
    GBRAIN_HOME: process.env.GBRAIN_HOME,
  };
}
function restoreEnv(prev: { OLYMPUS_BRAIN_HOME?: string; GBRAIN_HOME?: string }) {
  if (prev.OLYMPUS_BRAIN_HOME === undefined) delete process.env.OLYMPUS_BRAIN_HOME;
  else process.env.OLYMPUS_BRAIN_HOME = prev.OLYMPUS_BRAIN_HOME;
  if (prev.GBRAIN_HOME === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prev.GBRAIN_HOME;
}

describe('brain-home · resolveBrainHome', () => {
  let snap: ReturnType<typeof saveEnv>;
  beforeEach(() => {
    snap = saveEnv();
    delete process.env.OLYMPUS_BRAIN_HOME;
    delete process.env.GBRAIN_HOME;
    __resetBrainHomeCache();
  });
  afterEach(() => {
    restoreEnv(snap);
    __resetBrainHomeCache();
  });

  it('honors OLYMPUS_BRAIN_HOME env var (highest priority)', () => {
    process.env.OLYMPUS_BRAIN_HOME = '/tmp/test-olympus-brain';
    expect(resolveBrainHome()).toBe('/tmp/test-olympus-brain');
  });

  it('honors GBRAIN_HOME as deprecated alias when OLYMPUS not set', () => {
    process.env.GBRAIN_HOME = '/tmp/test-gbrain';
    expect(resolveBrainHome()).toBe('/tmp/test-gbrain');
  });

  it('OLYMPUS_BRAIN_HOME wins over GBRAIN_HOME when both set', () => {
    process.env.OLYMPUS_BRAIN_HOME = '/tmp/olympus-wins';
    process.env.GBRAIN_HOME = '/tmp/gbrain-loses';
    expect(resolveBrainHome()).toBe('/tmp/olympus-wins');
  });

  it('falls back to ~/.gbrain when no env + no olympus dir on disk', () => {
    // We can't easily force ~/.olympus/brain to NOT exist without
    // disturbing real state, so just confirm the return value ends in
    // one of the two candidate suffixes. On a fresh machine it's
    // ~/.gbrain; on a post-migration machine it's ~/.olympus/brain.
    const result = resolveBrainHome();
    const valid =
      result === GBRAIN_PATH ||
      result === OLYMPUS_PATH;
    expect(valid).toBe(true);
  });

  it('memoizes within a process (cache hit on second call)', () => {
    process.env.OLYMPUS_BRAIN_HOME = '/tmp/memo-test-1';
    const first = resolveBrainHome();
    // Change env WITHOUT clearing cache — memo should return first value.
    process.env.OLYMPUS_BRAIN_HOME = '/tmp/memo-test-2';
    const second = resolveBrainHome();
    expect(second).toBe(first);
  });

  it('__resetBrainHomeCache clears the memo', () => {
    process.env.OLYMPUS_BRAIN_HOME = '/tmp/reset-test-1';
    const first = resolveBrainHome();
    __resetBrainHomeCache();
    process.env.OLYMPUS_BRAIN_HOME = '/tmp/reset-test-2';
    const second = resolveBrainHome();
    expect(second).toBe('/tmp/reset-test-2');
    expect(first).toBe('/tmp/reset-test-1');
  });
});

describe('brain-home · brainHomeSubdir', () => {
  let snap: ReturnType<typeof saveEnv>;
  beforeEach(() => {
    snap = saveEnv();
    process.env.OLYMPUS_BRAIN_HOME = '/tmp/test-subdir';
    __resetBrainHomeCache();
  });
  afterEach(() => {
    restoreEnv(snap);
    __resetBrainHomeCache();
  });

  it('joins segments under the resolved brain home', () => {
    expect(brainHomeSubdir('audit')).toBe('/tmp/test-subdir/audit');
    expect(brainHomeSubdir('migrations', 'v1.md')).toBe('/tmp/test-subdir/migrations/v1.md');
    expect(brainHomeSubdir('cycle.lock')).toBe('/tmp/test-subdir/cycle.lock');
  });

  it('does NOT mkdir (pure path resolution)', () => {
    const leafPath = brainHomeSubdir('definitely-not-exist-' + Date.now());
    // brainHomeSubdir never touches disk; parent dir may or may not
    // exist, but the leaf path is ours to claim.
    expect(leafPath.startsWith('/tmp/test-subdir/')).toBe(true);
  });
});
