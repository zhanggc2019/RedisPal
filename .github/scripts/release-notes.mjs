import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { releaseVersion, stableTag } from './release-version.mjs'

/** Prefer authored notes, otherwise describe the commits after the preceding stable tag. */
export function releaseNotes(version, cwd = process.cwd()) {
  const { tag } = releaseVersion(version)
  const file = join(cwd, 'release-notes', `${tag}.md`)
  if (existsSync(file)) {
    const notes = readFileSync(file, 'utf8').replaceAll('\r\n', '\n').trim()
    if (notes) return notes + '\n'
  }

  const git = (...args) => execFileSync('git', ['-c', 'i18n.logOutputEncoding=utf-8', ...args], { cwd, encoding: 'utf8' }).trim()
  const tags = git('tag', '--merged', tag, '--sort=-version:refname').split(/\r?\n/)
  const position = tags.indexOf(tag)
  if (position < 0) throw new Error(`Could not find release tag ${tag}`)
  const previous = tags.slice(position + 1).find(candidate => stableTag.test(candidate))
  const subjects = git('log', '--format=%s', previous ? `${previous}..${tag}` : tag, '--')
  if (!subjects) return '## 中文\n\n- 本版本沿用上一版本的代码。\n\n## English\n\n- This release uses the same code as the previous version.\n'
  return subjects.split(/\r?\n/).map(subject => `- ${subject}`).join('\n') + '\n'
}

if (import.meta.main) {
  const { tag } = releaseVersion(process.argv[2])
  writeFileSync(join('release-notes', `${tag}.md`), releaseNotes(tag))
}
