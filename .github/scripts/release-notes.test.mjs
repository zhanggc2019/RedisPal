import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { releaseNotes } from './release-notes.mjs'

/** Create a disposable, tagged history without depending on the checkout depth. */
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'redispal-release-notes-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.name', 'RedisPal Test')
  git('config', 'user.email', 'redispal@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'tag.gpgSign', 'false')
  return { cwd, git }
}

test('preserves authored Chinese and English release notes', t => {
  const { cwd } = fixture(t)
  const notes = '## 中文\n\n- 优化连接。\n\n## English\n\n- Improve connections.\n'
  mkdirSync(join(cwd, 'release-notes'))
  writeFileSync(join(cwd, 'release-notes', 'v0.1.1.md'), notes)
  assert.equal(releaseNotes('v0.1.1', cwd), notes)
})

test('generates notes from the previous stable tag to the selected release', t => {
  const { cwd, git } = fixture(t)
  git('commit', '-q', '--allow-empty', '-m', 'Initial release')
  git('tag', 'v0.1.0')
  git('commit', '-q', '--allow-empty', '-m', 'Improve connections')
  git('tag', 'v0.1.1-rc.1')
  git('commit', '-q', '--allow-empty', '-m', '新增更新日志')
  git('tag', 'v0.1.1')
  git('commit', '-q', '--allow-empty', '-m', 'Unreleased change')

  const notes = releaseNotes('v0.1.1', cwd)
  assert.match(notes, /- 新增更新日志\n- Improve connections/)
  assert.doesNotMatch(notes, /Initial release|Unreleased change/)
  assert.throws(() => releaseNotes('v0.1.1-rc.1', cwd), /stable release tag/)
})
