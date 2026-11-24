import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** Compare stable tag components numerically, independently of machine locale. */
function compareVersions(left, right) {
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return 0
}

/** Pick the largest canonical stable tag from a set of Git refs. */
function newestTag(tags) {
  return tags.map(tag => tag.match(stableTag))
    .filter(Boolean)
    .map(match => match.slice(1).map(BigInt))
    .sort(compareVersions)
    .at(-1)
}

/** Reuse a tag on reruns, otherwise bump the latest stable patch from v0.0.0. */
export function nextReleaseTag(tags, commitTags) {
  const existing = newestTag(commitTags)
  if (existing) return 'v' + existing.join('.')
  const version = newestTag(tags) || [0n, 0n, 0n]
  version[2]++
  return 'v' + version.join('.')
}

/** Read tags from the checkout; failures stop a release rather than falling back. */
function gitTags(...args) {
  return execFileSync('git', ['tag', ...args], { encoding: 'utf8' }).split(/\r?\n/)
}

if (import.meta.main) {
  const tag = nextReleaseTag(gitTags('--list'), gitTags('--points-at', 'HEAD'))
  const output = 'tag=' + tag + '\nversion=' + tag.slice(1) + '\n'
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
  else process.stdout.write(output)
}
