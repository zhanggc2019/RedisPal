import assert from 'node:assert/strict'
import test from 'node:test'
import { nextReleaseTag } from './release-version.mjs'

// A repository without stable tags publishes v0.0.1 first.
test('starts at v0.0.1 and ignores prerelease and unrelated tags', () => {
  assert.equal(nextReleaseTag(['v0.0.9-rc.1', 'snapshot'], []), 'v0.0.1')
})

// Compare SemVer components numerically, including multiple-digit patch numbers.
test('increments the highest published patch across minor versions', () => {
  assert.equal(nextReleaseTag(['v0.0.2', 'v0.1.9', 'v0.0.19', 'v0.1.10'], []), 'v0.1.11')
})

// A rerun uses the existing tag for the same commit even after a later tag was published.
test('reuses a stable tag already pointing at the selected commit', () => {
  assert.equal(nextReleaseTag(['v0.0.1', 'v0.0.2'], ['v0.0.1', 'v0.0.9-beta']), 'v0.0.1')
})
