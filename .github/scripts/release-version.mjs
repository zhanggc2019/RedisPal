import { appendFileSync } from 'node:fs'

const stableTag = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

/** Derive the build version directly from the pushed stable release tag. */
export function releaseVersion(tag) {
  if (typeof tag !== 'string' || tag !== tag.trim() || !stableTag.test(tag)) {
    throw new Error('Expected a stable release tag in vX.Y.Z format')
  }
  return { tag, version: tag.slice(1) }
}

if (import.meta.main) {
  const { tag, version } = releaseVersion(process.env.GITHUB_REF_NAME)
  const output = 'tag=' + tag + '\nversion=' + version + '\n'
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
  else process.stdout.write(output)
}
