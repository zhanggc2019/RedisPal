import assert from 'node:assert/strict'
import test from 'node:test'
import { releaseVersion } from './release-version.mjs'

// The build receives exactly the tagged version with the Git tag prefix removed.
test('uses the exact version selected by the tag', () => {
  assert.deepEqual(releaseVersion('v0.0.2'), { tag: 'v0.0.2', version: '0.0.2' })
  assert.deepEqual(releaseVersion('v3.12.10'), { tag: 'v3.12.10', version: '3.12.10' })
})

// A missing or malformed tag cannot produce a fallback version or a release.
test('requires a stable vX.Y.Z tag', () => {
  for (const tag of [undefined, '', 'main', '0.0.2', 'v0.2', 'v02.0.0', 'v0.0.2-rc.1', 'v0.0.2\n']) {
    assert.throws(() => releaseVersion(tag), /vX.Y.Z/)
  }
})
