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
  'ls-tree -t HEAD docs/note.txt',
  'ls-tree -rt HEAD docs/nested/deep.txt',
  'ls-tree -rd HEAD docs/nested/',
  'ls-tree HEAD ./',
  'ls-tree HEAD docs/.',
  'ls-tree HEAD search.txt/',
  'ls-tree HEAD:search.txt',
  'ls-tree HEAD',
  'ls-tree -r HEAD',
  'ls-tree -rt HEAD',
  'ls-tree -d HEAD',
  'ls-tree -rd HEAD',
  'ls-tree --name-only HEAD',
  'ls-tree --name-status HEAD',
  'ls-tree -rz HEAD',
  'ls-tree -r --name-only HEAD',
  'ls-tree HEAD docs',
  'ls-tree HEAD docs/',
  'ls-tree HEAD docs/nested',
  'ls-tree HEAD docs/nested/',
  "ls-tree -r HEAD '*.txt'",
  'ls-tree HEAD -- docs/note.txt',
  'ls-tree HEAD^{tree}',
  'ls-tree HEAD:docs',
  'ls-tree v1',
  'ls-tree bad-revision',
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
  'ls-tree HEAD',
  'ls-tree -r HEAD',
  'ls-tree --full-name HEAD',
  'ls-tree --full-tree HEAD',
  'ls-tree HEAD ../search.txt',
  'ls-tree HEAD .',
])('matches from a subdirectory: %s', async (line) => {
  const native = spawnSync('bash', ['-c', `git ${line}`], { cwd: join(root, 'docs'), env: ENV })
  const result = await ws.shell(`cd /repo/docs && LC_ALL=C git ${line}`)
  expect([result.exitCode, Buffer.from(result.stdout), Buffer.from(result.stderr)]).toEqual([
    native.status,
    native.stdout,
    native.stderr,
  ])
})
