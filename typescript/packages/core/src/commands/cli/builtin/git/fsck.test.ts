import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs'
import { deflateSync } from 'node:zlib'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import { createShellParser, type ShellParser } from '../../../../shell/parse/index.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { MountMode } from '../../../../types.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { checkPack } from './fsck.ts'
import { GitError } from './errors.ts'
import type { Dispatch } from './types.ts'
import { IOResult } from '../../../../io/types.ts'
import { eacces } from '../../../../errors/fs.ts'
import { FileStat, FileType } from '../../../../types.ts'
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
    { encoding: 'utf8', stdio: 'pipe' },
  )
}
it.each([false, true])('checks native loose and packed objects (packed=%s)', async (packed) => {
  const root = mkdtempSync(join(tmpdir(), 'mirage-1330-'))
  let ws = workspace()
  try {
    native(root, ['init', '-q', '-b', 'main'])
    writeFileSync(join(root, 'a.txt'), 'before\n')
    native(root, ['add', '.'])
    native(root, ['commit', '-qm', 'first'])
    writeFileSync(join(root, 'a.txt'), 'before\nafter\n')
    native(root, ['stash', 'push', '-m', 'saved'])
    if (packed) native(root, ['gc', '--prune=now'])
    await load(ws, root)
    const checked = await ws.shell('git -C /repo fsck --no-dangling')
    expect(new TextDecoder().decode(checked.stderr)).toBe('')
    expect(checked.exitCode).toBe(0)
    if (!packed) {
      const oid = native(root, ['rev-parse', 'HEAD:a.txt']).trim()
      unlinkSync(join(root, '.git/objects', oid.slice(0, 2), oid.slice(2)))
      await ws.close()
      ws = workspace()
      await load(ws, root)
      const broken = await ws.shell('git -C /repo fsck --no-dangling')
      expect(broken.exitCode).not.toBe(0)
      expect(new TextDecoder().decode(broken.stderr)).toContain(oid)
    }
  } finally {
    await ws.close()
    rmSync(root, { recursive: true, force: true })
  }
})
it.each(['hash', 'zlib', 'pack', 'pack_content', 'index', 'missing_pack'])(
  'rejects corrupt objects (%s)',
  async (damage) => {
    const root = mkdtempSync(join(tmpdir(), 'mirage-fsck-'))
    const ws = workspace()
    try {
      native(root, ['init', '-q', '-b', 'main'])
      writeFileSync(join(root, 'a.txt'), 'before\n')
      native(root, ['add', '.'])
      native(root, ['commit', '-qm', 'first'])
      const oid = native(root, ['rev-parse', 'HEAD:a.txt']).trim()
      let diagnostic = oid
      if (
        damage === 'pack' ||
        damage === 'pack_content' ||
        damage === 'index' ||
        damage === 'missing_pack'
      ) {
        native(root, ['gc', '--prune=now'])
        const suffix = damage === 'index' ? '.idx' : '.pack'
        const folder = join(root, '.git/objects/pack')
        const name = readdirSync(folder).find((entry) => entry.endsWith(suffix))
        if (name === undefined) throw new Error('missing pack fixture')
        const path = join(folder, name)
        const content = readFileSync(path)
        const offset = damage === 'pack_content' ? 12 : content.length - 1
        content[offset] = (content[offset] ?? 0) ^ 0xff
        chmodSync(path, 0o600)
        writeFileSync(path, content)
        diagnostic = 'checksum'
        if (damage === 'missing_pack') {
          unlinkSync(path)
          diagnostic = `cannot read pack /repo/.git/objects/pack/${name}`
        }
      } else {
        const path = join(root, '.git/objects', oid.slice(0, 2), oid.slice(2))
        chmodSync(path, 0o600)
        writeFileSync(path, damage === 'hash' ? deflateSync('blob 7\0damaged') : 'broken zlib')
      }
      expect(() => native(root, ['fsck', '--no-dangling'])).toThrow()
      await load(ws, root)
      const result = await ws.shell('git -C /repo fsck --no-dangling')
      expect(result.exitCode).not.toBe(0)
      expect(new TextDecoder().decode(result.stderr).toLowerCase()).toContain(diagnostic)
    } finally {
      await ws.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
)

it.each([32, (1 << 18) + 5, (1 << 19) + 20])(
  'checksums bounded ranges (%i bytes)',
  async (length) => {
    const body = Uint8Array.from({ length: length - 20 }, (_, index) => index % 251)
    const checksum = createHash('sha1').update(body).digest()
    const data = new Uint8Array(length)
    data.set(body)
    data.set(checksum, body.length)
    for (const knownSize of [false, true]) {
      const reads: [number, number][] = []
      const dispatch: Dispatch = (op, _path, _args, kwargs) => {
        if (op === 'stat')
          return Promise.resolve([
            new FileStat({
              name: 'large.pack',
              type: FileType.FILE,
              size: knownSize ? data.length : null,
            }),
            new IOResult(),
          ])
        expect(op).toBe('read')
        const count = kwargs?.size as number
        const offset = kwargs?.offset as number
        expect(count).toBeGreaterThan(0)
        expect(count).toBeLessThanOrEqual(1 << 18)
        reads.push([offset, count])
        return Promise.resolve([data.subarray(offset, offset + count), new IOResult()])
      }
      await checkPack(dispatch, '/repo/.git/objects/pack/large.pack', checksum)
      expect(reads.length).toBeGreaterThanOrEqual(Math.ceil(data.length / (1 << 18)))
      expect(
        reads.reduce((sum, [offset, count]) => sum + Math.min(count, data.length - offset), 0),
      ).toBe(data.length)
    }
  },
)
it.each(['stat', 'read'])('preserves the path on pack permission errors (%s)', async (failedOp) => {
  const dispatch: Dispatch = (op, path) => {
    if (op === failedOp) return Promise.reject(eacces(path))
    return Promise.resolve([
      new FileStat({ name: 'denied.pack', type: FileType.FILE, size: 100 }),
      new IOResult(),
    ])
  }
  await expect(checkPack(dispatch, '/repo/denied.pack', new Uint8Array(20))).rejects.toMatchObject({
    message: 'cannot read pack /repo/denied.pack: Permission denied',
    code: new GitError('').code,
  })
})
