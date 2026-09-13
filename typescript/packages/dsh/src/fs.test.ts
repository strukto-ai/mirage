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

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsErrorCode } from '@deepseek-ai/dsh-fs'
import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import {
  DiskResource,
  LocalRuntime,
  Workspace,
  parseSessionProfile,
  registerResourceFactory,
} from '@struktoai/mirage-node'
import { MirageFileSystem } from './fs.ts'
import type { MirageFsConfig } from './fs.ts'
import { MirageService } from './service.ts'

const workspaces: Workspace[] = []

async function makeFs(
  seed: Record<string, string | Uint8Array> = {},
  options: { cwd?: string; readOnly?: boolean; diffBasisMaxBytes?: number } = {},
): Promise<{ fs: MirageFileSystem; ws: Workspace }> {
  const ram = new RAMResource()
  const ws = new Workspace({ '/data': [ram, MountMode.WRITE] })
  workspaces.push(ws)
  for (const [path, content] of Object.entries(seed)) {
    const full = `/data/${path}`
    const parts = full.split('/').slice(1, -1)
    let dir = ''
    for (const part of parts) {
      dir += `/${part}`
      if (dir !== '/data' && !(await ws.fs.isDir(dir))) await ws.fs.mkdir(dir)
    }
    await ws.fs.writeFile(full, content)
  }
  let target = ws
  if (options.readOnly === true) {
    target = new Workspace({ '/data': [ram, MountMode.READ] })
    workspaces.push(target)
  }
  const ctx = new Context()
  await ctx.plugin(MirageService, { workspace: target }).await()
  const config: MirageFsConfig = {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.diffBasisMaxBytes !== undefined
      ? { diffBasisMaxBytes: options.diffBasisMaxBytes }
      : {}),
  }
  await ctx.plugin(MirageFileSystem, config).await()
  return { fs: ctx.fs as MirageFileSystem, ws: target }
}

async function versionAt(fs: MirageFileSystem, path: string): Promise<FsVersion> {
  const info = await fs.stat(await fs.resolve(path))
  if (info === undefined) throw new Error(`expected ${path} to exist`)
  return info.version
}

async function errorCode(promise: Promise<unknown>): Promise<FsErrorCode> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(FsError)
    return (err as FsError).code
  }
  throw new Error('expected rejection')
}

const tempRoots: string[] = []

/**
 * A workspace with one disk mount, for the host-path mapping.
 *
 * @param prefix where the disk resource is mounted.
 * @returns the filesystem seam and the host directory behind the mount.
 */
async function makeDiskFs(
  prefix = '/work',
): Promise<{ fs: MirageFileSystem; root: string; ws: Workspace }> {
  const root = await mkdtemp(join(tmpdir(), 'mirage-dsh-host-'))
  tempRoots.push(root)
  const ws = new Workspace({ [prefix]: [new DiskResource({ root }), MountMode.WRITE] })
  workspaces.push(ws)
  const ctx = new Context()
  await ctx.plugin(MirageService, { workspace: ws }).await()
  await ctx.plugin(MirageFileSystem, {}).await()
  return { fs: ctx.fs as MirageFileSystem, root, ws }
}

afterEach(async () => {
  while (workspaces.length > 0) await workspaces.pop()?.close()
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  }
})

describe('resolve', () => {
  it('normalizes relative paths against the configured cwd', async () => {
    const { fs } = await makeFs({ 'a.txt': 'hello' }, { cwd: '/data' })
    const target = await fs.resolve('a.txt')
    expect(String(target.targetKey)).toBe('/data/a.txt')
    expect(target.displayPath).toBe('/data/a.txt')
  })

  it('ignores a caller cwd that names nothing in this world', async () => {
    const { fs } = await makeFs({ 'a.txt': 'hello' }, { cwd: '/data' })
    const target = await fs.resolve('a.txt', { cwd: '/Users/somebody/host-project' })
    expect(String(target.targetKey)).toBe('/data/a.txt')
    expect(await fs.readText(target)).toBe('hello')
  })

  it('honors a caller cwd that is a real directory here', async () => {
    const { fs } = await makeFs({ 'sub/b.txt': 'nested' }, { cwd: '/' })
    const target = await fs.resolve('b.txt', { cwd: '/data/sub' })
    expect(String(target.targetKey)).toBe('/data/sub/b.txt')
  })

  it('leaves an absolute path alone whatever the caller cwd says', async () => {
    const { fs } = await makeFs({ 'a.txt': 'hello' }, { cwd: '/' })
    const target = await fs.resolve('/data/a.txt', { cwd: '/Users/somebody/host-project' })
    expect(String(target.targetKey)).toBe('/data/a.txt')
  })

  it('ignores a host cwd for lstat too', async () => {
    const { fs } = await makeFs({ 'a.txt': 'hello' }, { cwd: '/data' })
    const info = await fs.lstat('a.txt', { cwd: '/Users/somebody/host-project' })
    expect(info?.type).toBe('file')
  })

  it('yields one target key for aliased spellings', async () => {
    const { fs } = await makeFs({ 'a.txt': 'hello' })
    const direct = await fs.resolve('/data/a.txt')
    const dotted = await fs.resolve('/data/./sub/../a.txt')
    expect(direct.targetKey).toBe(dotted.targetKey)
  })

  it('follows namespace symlinks to the canonical target', async () => {
    const { fs, ws } = await makeFs({ 'a.txt': 'hello' })
    await ws.fs.symlink('/data/link.txt', '/data/a.txt')
    const viaLink = await fs.resolve('/data/link.txt')
    expect(String(viaLink.targetKey)).toBe('/data/a.txt')
  })
})

describe('identity helpers', () => {
  it('answers containment on canonical keys', async () => {
    const { fs } = await makeFs({ 'sub/a.txt': 'x' })
    const root = await fs.resolve('/data')
    const child = await fs.resolve('/data/sub/a.txt')
    const sibling = await fs.resolve('/database')
    expect(fs.contains(root, child)).toBe(true)
    expect(fs.contains(root, root)).toBe(true)
    expect(fs.contains(root, sibling)).toBe(false)
    expect(fs.contains(child, root)).toBe(false)
  })

  it('renders processPath and fileUrl in virtual path space', async () => {
    const { fs } = await makeFs({ 'a b.txt': 'x' })
    const target = await fs.resolve('/data/a b.txt')
    expect(fs.processPath(target)).toBe('/data/a b.txt')
    expect(fs.fileUrl(target)).toBe('file:///data/a%20b.txt')
  })
})

describe('stat and lstat', () => {
  it('reports files with size and directories without failing', async () => {
    const { fs } = await makeFs({ 'a.txt': 'hello' })
    const file = await fs.stat(await fs.resolve('/data/a.txt'))
    expect(file?.type).toBe('file')
    expect(file?.size).toBe(5)
    const dir = await fs.stat(await fs.resolve('/data'))
    expect(dir?.type).toBe('directory')
  })

  it('reports an absent target as undefined', async () => {
    const { fs } = await makeFs()
    expect(await fs.stat(await fs.resolve('/data/nope'))).toBeUndefined()
  })

  it('moves the version token when content changes', async () => {
    const { fs, ws } = await makeFs({ 'a.txt': 'one' })
    const target = await fs.resolve('/data/a.txt')
    const before = await fs.stat(target)
    const again = await fs.stat(target)
    expect(again?.version).toBe(before?.version)
    await ws.fs.writeFile('/data/a.txt', 'three is longer')
    const after = await fs.stat(target)
    expect(after?.version).not.toBe(before?.version)
  })

  it('lstat reports the link itself, stat its target', async () => {
    const { fs, ws } = await makeFs({ 'a.txt': 'hello' })
    await ws.fs.symlink('/data/link.txt', '/data/a.txt')
    const path = await fs.lstat('/data/link.txt')
    expect(path?.type).toBe('symlink')
    expect(path?.size).toBe('/data/a.txt'.length)
    const followed = await fs.stat(await fs.resolve('/data/link.txt'))
    expect(followed?.type).toBe('file')
  })

  it('lstat reports a plain file and an absent path', async () => {
    const { fs } = await makeFs({ 'a.txt': 'hello' })
    expect((await fs.lstat('/data/a.txt'))?.type).toBe('file')
    expect(await fs.lstat('/data/nope')).toBeUndefined()
  })
})

describe('reads', () => {
  it('reads whole text', async () => {
    const { fs } = await makeFs({ 'a.txt': 'hello world' })
    expect(await fs.readText(await fs.resolve('/data/a.txt'))).toBe('hello world')
  })

  it('streams the same text semantics', async () => {
    const { fs } = await makeFs({ 'a.txt': 'chunked content' })
    const chunks: string[] = []
    for await (const chunk of await fs.streamText(await fs.resolve('/data/a.txt'))) {
      chunks.push(chunk)
    }
    expect(chunks.join('')).toBe('chunked content')
  })

  it('refuses binary content as FS_NOT_TEXT', async () => {
    const { fs } = await makeFs({ 'blob.bin': new Uint8Array([104, 105, 0, 106]) })
    expect(await errorCode(fs.readText(await fs.resolve('/data/blob.bin')))).toBe('FS_NOT_TEXT')
  })

  it('reports a missing file as FS_NOT_FOUND', async () => {
    const { fs } = await makeFs()
    expect(await errorCode(fs.readText(await fs.resolve('/data/nope')))).toBe('FS_NOT_FOUND')
  })
})

describe('readBytes', () => {
  it('returns raw bytes that readText refuses as binary', async () => {
    const blob = new Uint8Array([104, 105, 0, 106])
    const { fs } = await makeFs({ 'blob.bin': blob })
    const target = await fs.resolve('/data/blob.bin')
    expect(await fs.readBytes(target, undefined, 1024)).toEqual(blob)
    expect(await errorCode(fs.readText(target))).toBe('FS_NOT_TEXT')
  })

  it('admits a file exactly at the cap', async () => {
    const { fs } = await makeFs({ 'a.txt': 'hello' })
    const bytes = await fs.readBytes(await fs.resolve('/data/a.txt'), undefined, 5)
    expect(bytes.byteLength).toBe(5)
  })

  it('refuses a known over-cap size before fetching', async () => {
    const { fs } = await makeFs({ 'a.txt': 'hello world' })
    const target = await fs.resolve('/data/a.txt')
    expect(await errorCode(fs.readBytes(target, undefined, 4))).toBe('FS_TOO_LARGE')
  })

  it('refuses an over-cap read the backend reported no size for', async () => {
    const { fs } = await makeFs({ 'a.txt': 'hello world' })
    const target = await fs.resolve('/data/a.txt')
    const real = fs.stat.bind(fs)
    // Most API mounts report size null, so the cap has to hold on the
    // rendered length alone rather than truncating to it.
    fs.stat = async (t, signal) => {
      const info = await real(t, signal)
      if (info === undefined) return undefined
      return { version: info.version, type: info.type }
    }
    expect(await errorCode(fs.readBytes(target, undefined, 4))).toBe('FS_TOO_LARGE')
  })

  it('reports a missing file as FS_NOT_FOUND', async () => {
    const { fs } = await makeFs()
    const target = await fs.resolve('/data/nope')
    expect(await errorCode(fs.readBytes(target, undefined, 1024))).toBe('FS_NOT_FOUND')
  })

  it('refuses a directory as FS_NOT_REGULAR_FILE', async () => {
    const { fs } = await makeFs({ 'sub/a.txt': 'x' })
    const target = await fs.resolve('/data/sub')
    expect(await errorCode(fs.readBytes(target, undefined, 1024))).toBe('FS_NOT_REGULAR_FILE')
  })
})

describe('readByteRange', () => {
  const DEC = new TextDecoder()

  it('reads the window the caller asked for', async () => {
    const { fs } = await makeFs({ 'a.txt': '0123456789' })
    const target = await fs.resolve('/data/a.txt')
    expect(DEC.decode(await fs.readByteRange(target, { offset: 2, length: 3 }))).toBe('234')
  })

  it('comes back short when the file ends inside the window', async () => {
    const { fs } = await makeFs({ 'a.txt': '0123456789' })
    const target = await fs.resolve('/data/a.txt')
    expect(DEC.decode(await fs.readByteRange(target, { offset: 7, length: 99 }))).toBe('789')
  })

  it('answers empty at or past the end of the file', async () => {
    const { fs } = await makeFs({ 'a.txt': '0123456789' })
    const target = await fs.resolve('/data/a.txt')
    expect(await fs.readByteRange(target, { offset: 10, length: 4 })).toEqual(new Uint8Array(0))
    expect(await fs.readByteRange(target, { offset: 99, length: 4 })).toEqual(new Uint8Array(0))
  })

  it('answers empty for a zero-length window without reading', async () => {
    const { fs } = await makeFs({ 'a.txt': '0123456789' })
    const target = await fs.resolve('/data/a.txt')
    expect(await fs.readByteRange(target, { offset: 2, length: 0 })).toEqual(new Uint8Array(0))
  })

  it('decodes nothing and rejects nothing: a NUL rides through', async () => {
    const blob = new Uint8Array([104, 105, 0, 106])
    const { fs } = await makeFs({ 'blob.bin': blob })
    const target = await fs.resolve('/data/blob.bin')
    expect(await fs.readByteRange(target, { offset: 1, length: 3 })).toEqual(blob.slice(1, 4))
    // The same bytes through the text door are refused, which is the
    // difference this method exists for.
    expect(await errorCode(fs.readText(target))).toBe('FS_NOT_TEXT')
  })

  it('applies no cap of its own: the window is the only bound', async () => {
    const { fs } = await makeFs({ 'a.txt': 'x'.repeat(4096) })
    const target = await fs.resolve('/data/a.txt')
    const bytes = await fs.readByteRange(target, { offset: 0, length: 4096 })
    expect(bytes.byteLength).toBe(4096)
  })

  it('reports a missing file as FS_NOT_FOUND', async () => {
    const { fs } = await makeFs()
    const target = await fs.resolve('/data/nope')
    expect(await errorCode(fs.readByteRange(target, { offset: 0, length: 4 }))).toBe('FS_NOT_FOUND')
  })

  it('refuses a directory as FS_NOT_REGULAR_FILE', async () => {
    const { fs } = await makeFs({ 'sub/a.txt': 'x' })
    const target = await fs.resolve('/data/sub')
    expect(await errorCode(fs.readByteRange(target, { offset: 0, length: 4 }))).toBe(
      'FS_NOT_REGULAR_FILE',
    )
  })
})

describe('listDir', () => {
  it('lists children sorted with types, sizes and resolvable targets', async () => {
    const { fs } = await makeFs({ 'b.txt': 'bee', 'sub/c.txt': 'cee' })
    const entries = await fs.listDir(await fs.resolve('/data'))
    expect(entries.map((e) => e.name)).toEqual(['b.txt', 'sub'])
    expect(entries[0]?.type).toBe('file')
    expect(entries[0]?.size).toBe(3)
    expect(entries[1]?.type).toBe('directory')
    expect(String(entries[1]?.target.targetKey)).toBe('/data/sub')
  })

  it('merges namespace symlinks into the listing', async () => {
    const { fs, ws } = await makeFs({ 'a.txt': 'hello' })
    await ws.fs.symlink('/data/link.txt', '/data/a.txt')
    const entries = await fs.listDir(await fs.resolve('/data'))
    const link = entries.find((e) => e.name === 'link.txt')
    expect(link?.type).toBe('file')
    expect(String(link?.target.targetKey)).toBe('/data/a.txt')
  })

  it('refuses a file operand and a missing operand', async () => {
    const { fs } = await makeFs({ 'a.txt': 'x' })
    expect(await errorCode(fs.listDir(await fs.resolve('/data/a.txt')))).toBe('FS_NOT_DIRECTORY')
    expect(await errorCode(fs.listDir(await fs.resolve('/data/nope')))).toBe('FS_NOT_FOUND')
  })

  it('lists a cyclic symlink as an entry of unknown kind', async () => {
    const { fs, ws } = await makeFs({ 'a.txt': 'hello' })
    await ws.fs.symlink('/data/loop', '/data/loop')
    const entries = await fs.listDir(await fs.resolve('/data'))
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'loop'])
    const loop = entries.find((e) => e.name === 'loop')
    expect(loop?.type).toBe('other')
    expect(String(loop?.target.targetKey)).toBe('/data/loop')
  })
})

describe('writeText', () => {
  it('creates and updates with diff bases', async () => {
    const { fs } = await makeFs()
    const target = await fs.resolve('/data/new.txt')
    const created = await fs.writeText(target, 'first')
    expect(created.operation).toBe('create')
    expect(created.before).toBeNull()
    expect(created.after).toBe('first')
    const updated = await fs.writeText(target, 'second')
    expect(updated.operation).toBe('update')
    expect(updated.before).toBe('first')
    expect(updated.after).toBe('second')
    expect(await fs.readText(target)).toBe('second')
  })

  it('enforces createIfAbsent against an existing file', async () => {
    const { fs } = await makeFs({ 'a.txt': 'here' })
    const target = await fs.resolve('/data/a.txt')
    expect(await errorCode(fs.writeText(target, 'clobber', { kind: 'createIfAbsent' }))).toBe(
      'FS_NOT_OBSERVED',
    )
  })

  it('enforces replaceIfVersion against absence and staleness', async () => {
    const { fs } = await makeFs({ 'a.txt': 'v1' })
    const target = await fs.resolve('/data/a.txt')
    const absent = await fs.resolve('/data/nope.txt')
    expect(
      await errorCode(
        fs.writeText(absent, 'x', { kind: 'replaceIfVersion', version: FsVersion('meta::') }),
      ),
    ).toBe('FS_STALE_VERSION')
    const current = await versionAt(fs, '/data/a.txt')
    await fs.writeText(target, 'v2 much longer', {
      kind: 'replaceIfVersion',
      version: current,
    })
    expect(
      await errorCode(fs.writeText(target, 'v3', { kind: 'replaceIfVersion', version: current })),
    ).toBe('FS_STALE_VERSION')
  })

  it('reports a missing parent as FS_NOT_FOUND', async () => {
    const { fs } = await makeFs()
    const target = await fs.resolve('/data/no-dir/new.txt')
    expect(await errorCode(fs.writeText(target, 'x'))).toBe('FS_NOT_FOUND')
  })

  it('reports a read-only mount as FS_PERMISSION_DENIED', async () => {
    const { fs } = await makeFs({ 'a.txt': 'x' }, { readOnly: true })
    const target = await fs.resolve('/data/a.txt')
    expect(await errorCode(fs.writeText(target, 'y'))).toBe('FS_PERMISSION_DENIED')
  })

  it('measures the diff basis limit in UTF-8 bytes, not code units', async () => {
    const { fs } = await makeFs({ 'a.txt': 'old' }, { diffBasisMaxBytes: 10 })
    const target = await fs.resolve('/data/a.txt')
    // 4 code units but 12 UTF-8 bytes: over the limit, so no basis.
    const outcome = await fs.writeText(target, '文文文文')
    expect(outcome.operation).toBe('update')
    expect(outcome.before).toBeNull()
    expect(await fs.readText(target)).toBe('文文文文')
  })

  it('drops the per-target lock entry once the write settles', async () => {
    const { fs } = await makeFs({ 'a.txt': 'old' })
    const target = await fs.resolve('/data/a.txt')
    await Promise.all([fs.writeText(target, 'one'), fs.writeText(target, 'two much longer')])
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    const locks = (fs as unknown as { locks: Map<string, Promise<void>> }).locks
    expect(locks.size).toBe(0)
  })
})

describe('editText', () => {
  it('applies a unique literal edit with before and after', async () => {
    const { fs } = await makeFs({ 'a.txt': 'alpha beta gamma' })
    const target = await fs.resolve('/data/a.txt')
    const outcome = await fs.editText(target, {
      oldString: 'beta',
      newString: 'delta',
      replaceAll: false,
    })
    expect(outcome.before).toBe('alpha beta gamma')
    expect(outcome.after).toBe('alpha delta gamma')
    expect(await fs.readText(target)).toBe('alpha delta gamma')
  })

  it('replaces every match under replaceAll', async () => {
    const { fs } = await makeFs({ 'a.txt': 'x x x' })
    const target = await fs.resolve('/data/a.txt')
    const outcome = await fs.editText(target, { oldString: 'x', newString: 'y', replaceAll: true })
    expect(outcome.after).toBe('y y y')
  })

  it('classifies match failures', async () => {
    const { fs } = await makeFs({ 'a.txt': 'x x' })
    const target = await fs.resolve('/data/a.txt')
    expect(
      await errorCode(fs.editText(target, { oldString: 'z', newString: 'y', replaceAll: false })),
    ).toBe('FS_EDIT_NOT_FOUND')
    expect(
      await errorCode(fs.editText(target, { oldString: 'x', newString: 'y', replaceAll: false })),
    ).toBe('FS_AMBIGUOUS_EDIT')
  })

  it('guards versions before matching', async () => {
    const { fs, ws } = await makeFs({ 'a.txt': 'guarded content' })
    const target = await fs.resolve('/data/a.txt')
    const stale = await versionAt(fs, '/data/a.txt')
    await ws.fs.writeFile('/data/a.txt', 'now something else entirely')
    expect(
      await errorCode(
        fs.editText(
          target,
          { oldString: 'guarded', newString: 'x', replaceAll: false },
          { version: stale },
        ),
      ),
    ).toBe('FS_STALE_VERSION')
    const missing = await fs.resolve('/data/nope')
    expect(
      await errorCode(fs.editText(missing, { oldString: 'a', newString: 'b', replaceAll: false })),
    ).toBe('FS_STALE_VERSION')
  })
})

describe('cancellation across readiness', () => {
  it('refuses to dispatch a write whose signal fired during the ready wait', async () => {
    // The executor runs synchronously, so release is assigned by here.
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    registerResourceFactory('gated-ram-write', async () => {
      await gate
      return new RAMResource()
    })
    const ctx = new Context()
    const fiber = ctx.plugin(MirageService, {
      mounts: { '/data': { resource: 'gated-ram-write', mode: 'write' } },
    })
    await fiber.await()
    await ctx.plugin(MirageFileSystem, {}).await()
    const fs = ctx.fs as MirageFileSystem
    const controller = new AbortController()
    const target = { targetKey: FsTargetKey('/data/out.txt'), displayPath: '/data/out.txt' }
    const pending = fs.writeText(target, 'late', undefined, controller.signal)
    // One macrotask parks the write on the gated ready, past its entry
    // assertion; the abort then fires inside the wait window.
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    release()
    expect(await errorCode(pending)).toBe('FS_ABORTED')
    const ws = await ctx.mirage.ready
    expect(await ws.fs.exists('/data/out.txt')).toBe(false)
    await fiber.dispose()
  })
})

describe('sandbox policy', () => {
  const READ_ONLY = { mode: 'read-only', workspaceRoot: '/Users/somebody/host-project' } as const
  const WORKSPACE_WRITE = { mode: 'workspace-write', workspaceRoot: '/Users/somebody' } as const

  it('reports the same confinement the shell executor does', async () => {
    const { fs } = await makeFs()
    expect(fs.sandboxMode).toBe('workspace-write')
  })

  it('makes no claim once a runtime executes beyond the workspace', async () => {
    const { fs, ws } = await makeFs()
    ws.addRuntime(new LocalRuntime({ captures: ['python'] }))
    expect(fs.sandboxMode).toBeUndefined()
  })

  it('refuses a write under a read-only policy', async () => {
    const { fs, ws } = await makeFs()
    const target = await fs.resolve('/data/new.txt')
    expect(await errorCode(fs.writeText(target, 'x', undefined, undefined, READ_ONLY))).toBe(
      'FS_SANDBOX_DENIED',
    )
    expect(await ws.fs.exists('/data/new.txt')).toBe(false)
  })

  it('refuses an edit under a read-only policy', async () => {
    const { fs, ws } = await makeFs({ 'a.txt': 'one' })
    const target = await fs.resolve('/data/a.txt')
    const edit = { oldString: 'one', newString: 'two', replaceAll: false }
    expect(await errorCode(fs.editText(target, edit, undefined, undefined, READ_ONLY))).toBe(
      'FS_SANDBOX_DENIED',
    )
    expect(await ws.fs.readFileText('/data/a.txt')).toBe('one')
  })

  it('reads under a read-only policy, since only mutations are fenced', async () => {
    const { fs } = await makeFs({ 'a.txt': 'visible' })
    const target = await fs.resolve('/data/a.txt')
    expect(await fs.readText(target)).toBe('visible')
  })

  it('allows a write under a workspace-write policy', async () => {
    const { fs } = await makeFs()
    const target = await fs.resolve('/data/new.txt')
    const outcome = await fs.writeText(target, 'x', undefined, undefined, WORKSPACE_WRITE)
    expect(outcome.operation).toBe('create')
  })

  it('allows an unguarded write when the caller supplies no policy', async () => {
    const { fs } = await makeFs()
    const target = await fs.resolve('/data/new.txt')
    const outcome = await fs.writeText(target, 'x')
    expect(outcome.operation).toBe('create')
  })
})

describe('listDir cancellation', () => {
  it('stops walking children once the signal fires', async () => {
    const { fs, ws } = await makeFs({ 'a.txt': 'x', 'b.txt': 'y', 'c.txt': 'z' })
    const target = await fs.resolve('/data')
    const controller = new AbortController()
    // The walk's per-entry stats are index hits the readdir just warmed,
    // so the only deterministic window is the moment the listing lands.
    // Aborting as `readdir` returns puts the signal exactly there: with
    // the walk unguarded it would classify every child regardless.
    const ops = ws.fs
    const inner = ops.readdir.bind(ops)
    ops.readdir = async (path: string): Promise<string[]> => {
      const listing = await inner(path)
      controller.abort()
      return listing
    }
    expect(await errorCode(fs.listDir(target, controller.signal))).toBe('FS_ABORTED')
  })

  it('lists the whole directory when nothing aborts', async () => {
    const { fs } = await makeFs({ 'a.txt': 'x', 'b.txt': 'y' })
    const entries = await fs.listDir(await fs.resolve('/data'), new AbortController().signal)
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'b.txt'])
  })
})

describe('a policy refusal at the op door', () => {
  it('reads as a sandbox denial, so the tool layer offers the escalation', async () => {
    const ram = new RAMResource()
    const seeder = new Workspace({ '/data': [ram, MountMode.WRITE] })
    workspaces.push(seeder)
    await seeder.fs.writeFile('/data/keep.txt', 'original')
    const ws = new Workspace(
      { '/data': [ram, MountMode.WRITE] },
      {
        profiles: {
          agent: parseSessionProfile(
            { commands: { deny: [{ reason: 'keep.txt is frozen', paths: ['/data/keep.txt'] }] } },
            'profile agent',
          ),
        },
        profile: 'agent',
      },
    )
    workspaces.push(ws)
    const ctx = new Context()
    await ctx.plugin(MirageService, { workspace: ws }).await()
    await ctx.plugin(MirageFileSystem, {}).await()
    const fs = ctx.fs as MirageFileSystem
    const target = await fs.resolve('/data/keep.txt')
    const err = await fs.writeText(target, 'overwritten').catch((caught: unknown) => caught)
    expect(err).toBeInstanceOf(FsError)
    // Not FS_PERMISSION_DENIED: a mode refusal is the shape of this world,
    // while a rule is a confinement a call may be entitled to escalate past.
    expect((err as FsError).code).toBe('FS_SANDBOX_DENIED')
    expect((err as FsError).message).toContain('keep.txt is frozen')
  })

  it('still reads a plain mount-mode refusal as a permission denial', async () => {
    const { fs } = await makeFs({ 'a.txt': 'read only' }, { readOnly: true })
    const target = await fs.resolve('/data/a.txt')
    const err = await fs.writeText(target, 'nope').catch((caught: unknown) => caught)
    expect((err as FsError).code).toBe('FS_PERMISSION_DENIED')
  })
})

describe('processPathFromHostPath', () => {
  it('maps a host path under a disk mount onto its workspace path', async () => {
    const { fs, root } = await makeDiskFs()
    await writeFile(join(root, 'a.txt'), 'hello')
    expect(fs.processPathFromHostPath(join(root, 'a.txt'))).toBe('/work/a.txt')
  })

  it('maps a nested host path, separators and all', async () => {
    const { fs, root } = await makeDiskFs()
    const nested = ['sub', 'deeper', 'c.txt'].join(sep)
    expect(fs.processPathFromHostPath(join(root, nested))).toBe('/work/sub/deeper/c.txt')
  })

  it('maps the mount root itself without a trailing slash', async () => {
    const { fs, root } = await makeDiskFs()
    expect(fs.processPathFromHostPath(root)).toBe('/work')
  })

  it('normalizes a host path before matching', async () => {
    const { fs, root } = await makeDiskFs()
    expect(fs.processPathFromHostPath(join(root, 'sub', '..', 'a.txt'))).toBe('/work/a.txt')
  })

  it('declines a host path outside every disk mount', async () => {
    const { fs, root } = await makeDiskFs()
    expect(fs.processPathFromHostPath(resolve(root, '..', 'elsewhere.txt'))).toBeUndefined()
  })

  it('declines a relative path, having no host cwd to resolve it against', async () => {
    const { fs } = await makeDiskFs()
    expect(fs.processPathFromHostPath('a.txt')).toBeUndefined()
  })

  it('declines when no mount holds host files at all', async () => {
    // A ram mount holds the same bytes as nothing on the host, so there
    // is no path to answer with and inventing one would name a file the
    // caller cannot open.
    const { fs } = await makeFs({ 'a.txt': 'hello' })
    expect(fs.processPathFromHostPath('/data/a.txt')).toBeUndefined()
  })

  it('answers a path the shell and the fs seam both reach', async () => {
    const { fs, root, ws } = await makeDiskFs()
    await writeFile(join(root, 'a.txt'), 'hello')
    const virtual = fs.processPathFromHostPath(join(root, 'a.txt'))
    if (virtual === undefined) throw new Error('expected a mapping')
    // The point of the mapping: what it returns is live in this world,
    // not merely well-formed.
    expect(await ws.fs.readFileText(virtual)).toBe('hello')
    expect(await fs.readText(await fs.resolve(virtual))).toBe('hello')
  })
})
