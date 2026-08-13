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

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsErrorCode } from '@deepseek-ai/dsh-fs'
import { MountMode, RAMResource } from '@struktoai/mirage-core'
import { Workspace } from '@struktoai/mirage-node'
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

afterEach(async () => {
  while (workspaces.length > 0) await workspaces.pop()?.close()
})

describe('resolve', () => {
  it('normalizes relative paths against the configured cwd', async () => {
    const { fs } = await makeFs({ 'a.txt': 'hello' }, { cwd: '/data' })
    const target = await fs.resolve('a.txt')
    expect(String(target.targetKey)).toBe('/data/a.txt')
    expect(target.displayPath).toBe('/data/a.txt')
  })

  it('yields one target key for aliased spellings', async () => {
    const { fs } = await makeFs({ 'a.txt': 'hello' })
    const direct = await fs.resolve('/data/a.txt')
    const dotted = await fs.resolve('/data/./sub/../a.txt')
    expect(direct.targetKey).toBe(dotted.targetKey)
  })

  it('follows namespace symlinks to the canonical target', async () => {
    const { fs, ws } = await makeFs({ 'a.txt': 'hello' })
    await ws.fs.links?.symlink('/data/link.txt', '/data/a.txt', Date.now())
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
    await ws.fs.links?.symlink('/data/link.txt', '/data/a.txt', Date.now())
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
    await ws.fs.links?.symlink('/data/link.txt', '/data/a.txt', Date.now())
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
    await ws.fs.links?.symlink('/data/loop', '/data/loop', Date.now())
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
