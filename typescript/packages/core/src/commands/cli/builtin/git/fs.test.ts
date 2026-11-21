// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { PathSpec, MountMode } from '../../../../types.ts'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import git from 'isomorphic-git'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { IOResult } from '../../../../io/types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'

import { applyDelta, configValues, gitFs, openPacks, packedObject } from './fs.ts'
import { ensureDir } from './io.ts'
import type { CallerDispatchFn } from '../../../../context/session_context.ts'
import { Files } from '../../../../workspace/files.ts'

// The integ fixture builder, which is also what the differential harness hands
// the real git binary: one repository, half packed and half loose, so both read
// paths are exercised rather than only the easy one.
const BUILDER = fileURLToPath(
  new URL('../../../../../../../../integ/fixtures/git/build.sh', import.meta.url),
)

let tmp: string
let ws: Workspace
let fs: ReturnType<typeof gitFs>
let dispatch: Files

/** Every file under a directory, as repository-relative POSIX paths. */
function walk(root: string, base = root): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mirage-git-fs-'))
  const repo = join(tmp, 'repo')
  execFileSync('bash', [BUILDER, repo], { stdio: 'ignore' })

  const ram = new RAMVFS()
  ws = new Workspace({ '/repo': ram }, { mode: MountMode.WRITE })
  // Copied into RAM rather than mounted from disk on purpose: a repository that
  // reads correctly out of a keyed store is proof the bridge goes through the
  // dispatcher and not through the filesystem underneath it.
  // The session's files, which is what a CLI leaf is handed inside a
  // workspace.
  dispatch = ws.vfs
  for (const rel of walk(repo)) {
    const target = `/repo/${rel}`
    await ensureDir(dispatch, PathSpec.fromStrPath(target).parent)
    await ws.dispatch('write', target, [new Uint8Array(readFileSync(join(repo, rel)))])
  }
  fs = gitFs(dispatch)
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const opts = (): { fs: never; dir: string; gitdir: string } => ({
  fs: fs as never,
  dir: '/repo',
  gitdir: '/repo/.git',
})

describe('gitFs', () => {
  it('reads history out of a mount', async () => {
    const log = await git.log(opts())
    expect(log.map((c) => c.commit.message.trim())).toEqual([
      'add two',
      'add docs',
      'add delta',
      'first commit',
    ])
  })

  it('reads a packed object, not only the loose half', async () => {
    // `repack -adq` packed the first three commits, so the oldest one only
    // resolves if the packfile and its index were both read through the mount.
    const log = await git.log(opts())
    const oldest = log[log.length - 1]
    expect(oldest).toBeDefined()
    const blob = await git.readBlob({ ...opts(), oid: oldest?.oid ?? '', filepath: 'letters.txt' })
    expect(new TextDecoder().decode(blob.blob)).toBe('alpha\nbeta\ngamma\n')
  })

  it('reads the branches', async () => {
    expect((await git.listBranches({ ...opts() })).sort()).toEqual(['main', 'topic'])
  })

  it('reads the index', async () => {
    expect((await git.listFiles(opts())).sort()).toEqual([
      'docs/readme.md',
      'letters.txt',
      'numbers.txt',
    ])
  })

  it("serves a packed object as a loose one, the pack index out of the library's sight", async () => {
    const at = PathSpec.fromStrPath('/repo/.git')
    const bridged = gitFs(dispatch, {
      gitdir: at,
      commondir: at,
      worktree: PathSpec.fromStrPath('/repo'),
      mountRoot: PathSpec.fromStrPath('/repo'),
    })
    const pack = join(tmp, 'repo', '.git', 'objects', 'pack')
    const idx = readdirSync(pack).find((name) => name.endsWith('.idx')) ?? ''
    const listed = execFileSync('git', ['verify-pack', '-v', join(pack, idx)], { encoding: 'utf8' })
    const [, oid = '', type = ''] = /^([0-9a-f]{40}) (commit|tree|blob) /m.exec(listed) ?? []
    const loose = `/repo/.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`
    expect(await dispatch.exists(PathSpec.fromStrPath(loose))).toBe(false)
    const content = execFileSync('git', ['-C', join(tmp, 'repo'), 'cat-file', type, oid])
    const read = bridged.promises.readFile as unknown as (path: string) => Promise<Uint8Array>
    const exists = bridged.promises.exists as unknown as (path: string) => Promise<boolean>
    const readdir = bridged.promises.readdir as unknown as (path: string) => Promise<string[]>
    expect(Buffer.from(inflateSync(await read(loose)))).toEqual(
      Buffer.concat([Buffer.from(`${type} ${String(content.length)}\0`), content]),
    )
    expect(await exists(loose)).toBe(true)
    expect(await exists(`/repo/.git/objects/${oid.slice(0, 2)}/${'0'.repeat(38)}`)).toBe(false)
    const names = await readdir('/repo/.git/objects/pack')
    expect(names.some((name) => name.endsWith('.pack'))).toBe(true)
    expect(names.some((name) => name.endsWith('.idx'))).toBe(false)
    const log = await git.log({ fs: bridged as never, dir: '/repo', gitdir: '/repo/.git' })
    expect(log.map((c) => c.commit.message.trim())).toEqual([
      'add two',
      'add docs',
      'add delta',
      'first commit',
    ])
  })

  it('writes an object back through the mount', async () => {
    const oid = await git.writeBlob({ ...opts(), blob: new TextEncoder().encode('written\n') })
    const back = await git.readBlob({ ...opts(), oid })
    expect(new TextDecoder().decode(back.blob)).toBe('written\n')
  })
})

describe('configValues', () => {
  it("reads every value as written, below isomorphic-git's own casts", async () => {
    await ensureDir(dispatch, PathSpec.fromStrPath('/repo/cfg'))
    const text =
      '[core]\n\tbare = 1\n[Core]\n\tBare = yes\n\tbare\n\tbare =\n[core "sub"]\n\tbare = no\n'
    await ws.dispatch('write', '/repo/cfg/config', [new TextEncoder().encode(text)])
    const location = {
      gitdir: PathSpec.fromStrPath('/repo/cfg'),
      commondir: PathSpec.fromStrPath('/repo/cfg'),
      worktree: PathSpec.fromStrPath('/repo'),
      mountRoot: PathSpec.fromStrPath('/repo'),
    }
    expect(await configValues(dispatch, location, 'core.bare')).toEqual(['1', 'yes', 'true', ''])
    expect(await configValues(dispatch, location, 'CORE.Bare')).toEqual(['1', 'yes', 'true', ''])
    expect(await configValues(dispatch, location, 'core.sub.bare')).toEqual(['no'])
    await ws.dispatch('write', '/repo/cfg/config', [
      new TextEncoder().encode('[branch "q\\"x"]\n\tremote = origin\n'),
    ])
    expect(await configValues(dispatch, location, 'branch.q"x.remote')).toEqual(['origin'])
    expect(await configValues(dispatch, location, 'core.worktree')).toEqual([])
    const nowhere = {
      ...location,
      gitdir: PathSpec.fromStrPath('/repo/none'),
      commondir: PathSpec.fromStrPath('/repo/none'),
    }
    expect(await configValues(dispatch, nowhere, 'core.bare')).toEqual([])
  })
})

it('restores typed repository roots across the library string boundary', async () => {
  const seen: PathSpec[] = []
  const source: CallerDispatchFn = (_op, path) => {
    seen.push(path)
    return Promise.resolve([new Uint8Array(), new IOResult()])
  }
  const fs = gitFs(new Files(source), {
    gitdir: PathSpec.fromStrPath('/hidden/../checkout', undefined, '/'),
    commondir: PathSpec.fromStrPath('/blocked/../shared', undefined, '/'),
    worktree: PathSpec.fromStrPath('/private/../work', undefined, '/'),
    mountRoot: PathSpec.fromStrPath('/'),
  })
  const read = fs.promises.readFile as unknown as (path: string) => Promise<unknown>
  await read('/checkout/HEAD')
  await read('/checkout/objects/pack/data')
  await read('/checkout/refs/worktree/local')
  await read('/work/file')
  expect(seen.map((path) => path.dotted)).toEqual([
    '/hidden/../checkout/HEAD',
    '/blocked/../shared/objects/pack/data',
    '/hidden/../checkout/refs/worktree/local',
    '/private/../work/file',
  ])
})

const LONE = `ab${'0'.repeat(38)}`

/** A repository whose one pack holds `entry` at offset 12, under a v1 index naming it LONE. */
async function lonePack(entry: Uint8Array): Promise<Files> {
  const vfs = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE }).vfs
  const pack = new Uint8Array([
    0x50,
    0x41,
    0x43,
    0x4b,
    0,
    0,
    0,
    2,
    0,
    0,
    0,
    1,
    ...entry,
    ...new Uint8Array(20),
  ])
  const idx = new Uint8Array(256 * 4 + 24 + 40)
  const view = new DataView(idx.buffer)
  for (let byte = 0xab; byte < 256; byte++) view.setUint32(byte * 4, 1)
  view.setUint32(256 * 4, 12)
  idx.set([0xab], 256 * 4 + 4)
  const dir = PathSpec.fromStrPath('/r/.git/objects/pack')
  await ensureDir(vfs, dir)
  await vfs.write(dir.join('pack-x.pack'), pack)
  await vfs.write(dir.join('pack-x.idx'), idx)
  return vfs
}

describe('packed reads of a damaged pack', () => {
  const at = PathSpec.fromStrPath('/r/.git')

  it('refuses a delta that ends inside a size or an operand', () => {
    const abcd = new TextEncoder().encode('abcd')
    expect(() => applyDelta(new Uint8Array([0x00]), new Uint8Array())).toThrow(
      'delta ends inside an instruction',
    )
    expect(() => applyDelta(new Uint8Array([0x04, 0x04, 0x91, 0x00]), abcd)).toThrow(
      'delta ends inside an instruction',
    )
    expect(applyDelta(new Uint8Array([0x04, 0x04, 0x90, 0x04]), abcd)).toEqual(abcd)
  })

  it('refuses an offset delta whose base does not come before it', async () => {
    const vfs = await lonePack(new Uint8Array([0x60, 0x00, ...deflateSync(new Uint8Array([0, 0]))]))
    await expect(packedObject(openPacks(vfs, at), LONE)).rejects.toThrow(
      'pack has bad object at offset 12: delta base offset is out of bound',
    )
  })

  it('reports an object that does not inflate as unreadable, not missing', async () => {
    const vfs = await lonePack(new Uint8Array([0x35, 0x78, 0x9c, 0xff, 0xff, 0xff]))
    const bridged = gitFs(vfs, {
      gitdir: at,
      commondir: at,
      worktree: at.parent,
      mountRoot: at.parent,
    })
    const read = (oid: string): Promise<unknown> =>
      git.readBlob({ fs: bridged as never, gitdir: '/r/.git', oid })
    const err: unknown = await read(LONE).catch((caught: unknown) => caught)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(git.Errors.NotFoundError)
    await expect(read('cd'.padEnd(40, '0'))).rejects.toBeInstanceOf(git.Errors.NotFoundError)
  })
})
