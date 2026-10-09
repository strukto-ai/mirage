import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createShellParser } from '../../../../shell/parse/index.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { MountMode } from '../../../../types.ts'
import { GIT } from './index.ts'

const require = createRequire(import.meta.url)
const ENV = {
  ...process.env,
  LC_ALL: 'C',
  LANG: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}
let root: string
let ws: Workspace

async function load(relative = ''): Promise<void> {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      await ws.dispatch('mkdir', `/repo/${path}`)
      await load(path)
    } else await ws.dispatch('write', `/repo/${path}`, [readFileSync(join(root, path))])
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mirage-git-search-'))
  const run = (args: string[]) => execFileSync('git', args, { cwd: root, env: ENV, stdio: 'pipe' })
  run(['init', '-q', '-b', 'main'])
  writeFileSync(join(root, 'a.txt'), 'one\n')
  run(['add', '.'])
  run(['commit', '-qm', 'first'])
  mkdirSync(join(root, 'docs/nested'), { recursive: true })
  for (const [name, data] of Object.entries({
    'search.txt': 'one\nONE\nstone\n@\na|b\nlast',
    'docs/note.txt': 'one\nother\n',
    'docs/nested/deep.txt': 'one\n',
    'binary.dat': 'one\0more\n',
    'empty.txt': '',
    'tab\tname.txt': 'one\n',
  }))
    writeFileSync(join(root, name), data)
  run(['add', '.'])
  run(['commit', '-qm', 'search'])
  run(['tag', '-a', 'v1', '-m', 'tag'])
  writeFileSync(join(root, 'search.txt'), 'staged\n')
  run(['add', 'search.txt'])
  writeFileSync(join(root, 'search.txt'), 'working\none\n')
  writeFileSync(join(root, 'untracked.txt'), 'one\n')
  const parser = await createShellParser({
    engineWasm: readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm')),
    grammarWasm: readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm')),
  })
  ws = new Workspace({ '/repo': new RAMVFS() }, { mode: MountMode.WRITE, shellParser: parser })
  await load()
  ws.registerCli('git', GIT)
})

afterAll(async () => {
  await ws.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

it.each([
  'grep one --cached -- docs',
  'grep one -I',
  'grep -- --',
  'grep -e one -- docs',
  'grep -Ll one HEAD',
  'grep -lL one HEAD',
  'grep -n one HEAD:search.txt',
  'grep -n one HEAD:search.txt -- NOSUCH',
  'grep -n one HEAD:search.txt HEAD:search.txt',
  'grep one',
  'grep -n one',
  'grep -n one HEAD',
  'grep -n one HEAD~1 HEAD',
  'grep --cached -n staged',
  'grep -n working',
  'grep --cached -n working',
  'grep -i -n ONE HEAD',
  "grep -F -n 'a|b' HEAD",
  "grep -E -n 'one|other' HEAD",
  "grep -F -E -n 'one|other' HEAD",
  "grep -E -F -n 'one|other' HEAD",
  'grep -w -n one HEAD',
  "grep -w '@' HEAD",
  'grep -v -n one HEAD -- docs',
  'grep -c one HEAD',
  'grep -c NOMATCH HEAD',
  'grep -l one HEAD',
  'grep -L one HEAD',
  'grep -L NOMATCH HEAD',
  'grep -q one HEAD',
  'grep -q NOMATCH HEAD',
  'grep -e one -e other HEAD',
  "grep -n -e 'one\nother' HEAD",
  'grep -n one -- docs',
  'grep -n one docs',
  "grep -n one '*.txt'",
  'grep -n one HEAD -- docs',
  'grep -nz one HEAD',
  'grep -lz one HEAD',
  'grep -a -n one HEAD -- binary.dat',
  'grep -I one HEAD',
  'grep -I -L one HEAD',
  'grep -h -n one HEAD -- docs',
  'grep -H -n one HEAD -- docs',
  'grep',
  'grep --cached one HEAD',
  'grep one NOSUCH --',
  'grep one NOSUCH',
  'grep -n one HEAD:docs',
])('matches native Git: %s', async (line) => {
  const native = spawnSync('bash', ['-c', `git ${line}`], { cwd: root, env: ENV })
  const result = await ws.shell(`LC_ALL=C git -C /repo ${line}`)
  expect([result.exitCode, Buffer.from(result.stdout), Buffer.from(result.stderr)]).toEqual([
    native.status,
    native.stdout,
    native.stderr,
  ])
})

it.each([
  'grep -n one',
  'grep -n one HEAD',
  'grep -n one HEAD -- ..',
  'grep -n one -- ../search.txt',
])('matches from a subdirectory: %s', async (line) => {
  const native = spawnSync('bash', ['-c', `git ${line}`], { cwd: join(root, 'docs'), env: ENV })
  const result = await ws.shell(`cd /repo/docs && LC_ALL=C git ${line}`)
  expect([result.exitCode, Buffer.from(result.stdout), Buffer.from(result.stderr)]).toEqual([
    native.status,
    native.stdout,
    native.stderr,
  ])
})

it.each(['*a', '+a', '?a', '(?=a)'])(
  'uses Git POSIX ERE rather than egrep: %s',
  async (pattern) => {
    const native = spawnSync('git', ['grep', '-E', pattern, 'HEAD'], { cwd: root, env: ENV })
    const actual = await ws.shell(`git -C /repo grep -E '${pattern}' HEAD`)
    expect(actual.exitCode).toBe(native.status)
    expect(actual.exitCode).toBe(128)
    expect(new TextDecoder().decode(actual.stderr)).toMatch(/^fatal: command line, '/)
  },
)

it('searches unmerged working files but not cached stages', async () => {
  const oldIndex = readFileSync(join(root, '.git/index'))
  const oid = execFileSync('git', ['rev-parse', 'HEAD:search.txt'], {
    cwd: root,
    env: ENV,
    encoding: 'utf8',
  }).trim()
  const input = [1, 2, 3].map((stage) => `100644 ${oid} ${String(stage)}\tconflict.txt\n`).join('')
  execFileSync('git', ['update-index', '--index-info'], { cwd: root, env: ENV, input })
  writeFileSync(join(root, 'conflict.txt'), 'ours\n<<<<<<<\nother\n')
  await ws.dispatch('write', '/repo/.git/index', [readFileSync(join(root, '.git/index'))])
  await ws.dispatch('write', '/repo/conflict.txt', [Buffer.from('ours\n<<<<<<<\nother\n')])
  try {
    for (const line of [
      'grep ours -- conflict.txt',
      'grep other -- conflict.txt',
      'grep --cached one -- conflict.txt',
    ]) {
      const native = spawnSync('bash', ['-c', `git ${line}`], { cwd: root, env: ENV })
      const actual = await ws.shell(`git -C /repo ${line}`)
      expect([actual.exitCode, Buffer.from(actual.stdout), Buffer.from(actual.stderr)]).toEqual([
        native.status,
        native.stdout,
        native.stderr,
      ])
    }
  } finally {
    writeFileSync(join(root, '.git/index'), oldIndex)
    await ws.dispatch('write', '/repo/.git/index', [oldIndex])
  }
})

it('follows namespace directory links while retaining tracked labels', async () => {
  const moved = await ws.shell('mv /repo/docs /repo/moved && ln -s moved /repo/docs')
  expect(moved.exitCode).toBe(0)
  try {
    const actual = await ws.shell('git -C /repo grep one -- docs')
    expect(actual.exitCode).toBe(0)
    expect(new TextDecoder().decode(actual.stdout)).toBe(
      'docs/nested/deep.txt:one\ndocs/note.txt:one\n',
    )
  } finally {
    await ws.shell('rm /repo/docs && mv /repo/moved /repo/docs')
  }
})

it('requires a worktree only for the default source', async () => {
  execFileSync('git', ['init', '-q', '--bare', join(root, 'bare')], { env: ENV })
  expect((await ws.shell('git init -q --bare /repo/bare')).exitCode).toBe(0)
  for (const options of [[], ['--cached']]) {
    const native = spawnSync('git', ['--git-dir', join(root, 'bare'), 'grep', ...options, 'one'], {
      env: ENV,
    })
    const actual = await ws.shell(`git --git-dir /repo/bare grep ${options.join(' ')} one`)
    expect([actual.exitCode, Buffer.from(actual.stdout), Buffer.from(actual.stderr)]).toEqual([
      native.status,
      native.stdout,
      native.stderr,
    ])
  }
})

it('treats bare -h as usage rather than a missing pattern', async () => {
  const actual = await ws.shell('git -C /repo grep -h')
  expect(actual.exitCode).toBe(129)
  expect(new TextDecoder().decode(actual.stdout)).toMatch(/^usage: git grep /)
  expect(actual.stderr.length).toBe(0)
})

it('skips a regular tracked file replaced by a namespace symlink', async () => {
  expect(
    (await ws.shell('rm /repo/search.txt && ln -s docs/note.txt /repo/search.txt')).exitCode,
  ).toBe(0)
  try {
    const actual = await ws.shell('git -C /repo grep one -- search.txt')
    expect(actual.exitCode).toBe(1)
    expect(actual.stdout.length).toBe(0)
  } finally {
    await ws.shell('rm /repo/search.txt')
    await ws.dispatch('write', '/repo/search.txt', [Buffer.from('working\none\n')])
  }
})
