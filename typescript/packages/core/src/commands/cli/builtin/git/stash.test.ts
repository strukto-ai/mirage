import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import { createShellParser, type ShellParser } from '../../../../shell/parse/index.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { MountMode } from '../../../../types.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { GIT } from './index.ts'

const require = createRequire(import.meta.url)
let parser: ShellParser
beforeAll(async () => {
  parser = await createShellParser({
    engineWasm: readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm')),
    grammarWasm: readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm')),
  })
})
function workspace(): Workspace {
  const ws = new Workspace(
    { '/repo': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: parser },
  )
  ws.registerCli('git', GIT)
  return ws
}
async function load(ws: Workspace, root: string, relative = ''): Promise<void> {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      await ws.shell(`mkdir -p /repo/${name}`)
      await load(ws, root, name)
    } else await ws.dispatch('write', `/repo/${name}`, [readFileSync(join(root, name))])
  }
}
function native(root: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { encoding: 'utf8' },
  )
}
it.each([false, true])('reads native stashes (packed=%s)', async (packed) => {
  const root = mkdtempSync(join(tmpdir(), 'mirage-1330-'))
  const ws = workspace()
  try {
    native(root, ['init', '-q', '-b', 'main'])
    writeFileSync(join(root, 'a.txt'), 'before\n')
    native(root, ['add', '.'])
    native(root, ['commit', '-qm', 'first'])
    writeFileSync(join(root, 'a.txt'), 'before\nafter\n')
    native(root, ['stash', 'push', '-m', 'saved'])
    if (packed) native(root, ['gc', '--prune=now'])
    await load(ws, root)
    for (const args of [
      ['stash', 'list'],
      ['stash', 'show'],
      ['stash', 'show', '-p'],
      ['stash', 'show', '--name-only', 'stash@{0}'],
    ]) {
      const result = await ws.shell('git -C /repo ' + args.join(' '))
      expect(new TextDecoder().decode(result.stderr)).toBe('')
      expect(result.exitCode).toBe(0)
      expect(new TextDecoder().decode(result.stdout)).toBe(native(root, args))
    }
  } finally {
    await ws.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('skips blank stash reflog rows as git does', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mirage-blank-'))
  const ws = workspace()
  try {
    native(root, ['init', '-q', '-b', 'main'])
    writeFileSync(join(root, 'a.txt'), 'before\n')
    native(root, ['add', '.'])
    native(root, ['commit', '-qm', 'first'])
    for (const change of ['first stash\n', 'second stash\n']) {
      writeFileSync(join(root, 'a.txt'), `before\n${change}`)
      native(root, ['stash', 'push', '-q'])
    }
    const log = join(root, '.git/logs/refs/stash')
    const rows = readFileSync(log, 'utf8').split('\n').filter(Boolean)
    writeFileSync(log, `${rows.join('\n\n')}\n\n`)
    await load(ws, root)
    for (const args of [
      ['stash', 'list'],
      ['stash', 'show'],
      ['stash', 'show', 'stash@{1}'],
      ['stash', 'show', '1'],
      ['stash', 'show', 'stash@{2}'],
    ]) {
      const expected = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
      const result = await ws.shell('git -C /repo ' + args.join(' '))
      expect([
        result.exitCode,
        new TextDecoder().decode(result.stdout),
        new TextDecoder().decode(result.stderr),
      ]).toEqual([expected.status, expected.stdout, expected.stderr])
    }
  } finally {
    await ws.close()
    rmSync(root, { recursive: true, force: true })
  }
})
