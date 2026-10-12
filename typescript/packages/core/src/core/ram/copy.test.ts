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

import { describe, expect, it } from 'vitest'
import { RAMAccessor } from '../../accessor/ram.ts'
import { materialize } from '../../io/types.ts'
import { RAMStore } from '../../vfs/ram/store.ts'
import { DevFiles, DevStore } from '../../vfs/dev/store.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode, PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { DevicePipe } from '../dev/pipe.ts'
import { copy } from './copy.ts'

const DEC = new TextDecoder()

function devStore(): DevStore {
  return new DevStore(new DevFiles('owner'))
}

function devAccessor(store: DevStore): RAMAccessor {
  return new RAMAccessor(store as unknown as RAMStore)
}

function devPath(key: string): PathSpec {
  return new PathSpec({
    virtual: `/dev${key}`,
    directory: `/dev${key.slice(0, key.lastIndexOf('/') + 1)}`,
    vfsPath: key.slice(1),
    resolved: true,
  })
}

function mkPath(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    vfsPath: stripSlash(virtual),
    resolved: true,
  })
}

function mkAccessor(): RAMAccessor {
  const store = new RAMStore()
  const enc = new TextEncoder()
  store.files.set('/a.txt', enc.encode('hi'))
  store.files.set('/plain', enc.encode('y'))
  store.dirs.add('/dir')
  store.files.set('/dir/f', enc.encode('x'))
  store.dirs.add('/d')
  return new RAMAccessor(store)
}

async function codeOf(fn: () => Promise<void>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE'
  }
  return 'NO_THROW'
}

describe('core/ram copy', () => {
  it('copies a file', async () => {
    const acc = mkAccessor()
    await copy(acc, mkPath('/a.txt'), mkPath('/d/b.txt'))
    expect(acc.store.files.has('/d/b.txt')).toBe(true)
    expect(acc.store.files.has('/a.txt')).toBe(true)
  })

  it('a missing source is ENOENT', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => copy(acc, mkPath('/nope'), mkPath('/d/x')))).toBe('ENOENT')
  })

  it('into a missing parent is ENOENT and leaves no orphan', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => copy(acc, mkPath('/a.txt'), mkPath('/missing/a.txt')))).toBe('ENOENT')
    expect(acc.store.files.has('/missing/a.txt')).toBe(false)
  })

  it('a missing grandparent is ENOENT', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => copy(acc, mkPath('/a.txt'), mkPath('/missing/sub/a.txt')))).toBe(
      'ENOENT',
    )
    expect(acc.store.files.has('/missing/sub/a.txt')).toBe(false)
  })

  it('a parent that is a plain file is ENOTDIR', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => copy(acc, mkPath('/a.txt'), mkPath('/plain/c.txt')))).toBe('ENOTDIR')
    expect(acc.store.files.has('/plain/c.txt')).toBe(false)
  })

  it('a plain file deeper in the parent chain is ENOTDIR', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => copy(acc, mkPath('/a.txt'), mkPath('/plain/sub/c.txt')))).toBe(
      'ENOTDIR',
    )
  })

  it('a root child is allowed', async () => {
    const acc = mkAccessor()
    await copy(acc, mkPath('/a.txt'), mkPath('/b.txt'))
    expect(acc.store.files.has('/b.txt')).toBe(true)
  })
})

describe('core/ram copy through a pipe', () => {
  it('copy reads a pipe source through its reader', async () => {
    const store = devStore()
    const source = new DevicePipe(true)
    const [path] = store.files.allocateInput(source)
    await source.pipe.write(new TextEncoder().encode('hello'))
    source.pipe.end()
    await copy(devAccessor(store), devPath(path.slice(4)), devPath('/copied'))
    expect(DEC.decode(store.files.get('/copied'))).toBe('hello')
    expect(store.files.pipeOf(path.slice(4))).toBe(source)
  })

  it('copy writes into a pipe destination', async () => {
    const store = devStore()
    store.files.set('/src', new TextEncoder().encode('hello'))
    const target = new DevicePipe(false)
    const [path] = store.files.allocateInput(target)
    const consumed = materialize(target.pipe.stream())
    await copy(devAccessor(store), devPath('/src'), devPath(path.slice(4)))
    target.pipe.end()
    expect(DEC.decode(await consumed)).toBe('hello')
  })

  it('copy between two pipes streams through both', async () => {
    const store = devStore()
    const source = new DevicePipe(true)
    const target = new DevicePipe(false)
    const [src] = store.files.allocateInput(source)
    const [dst] = store.files.allocateInput(target)
    await source.pipe.write(new TextEncoder().encode('through'))
    source.pipe.end()
    const consumed = materialize(target.pipe.stream())
    await copy(devAccessor(store), devPath(src.slice(4)), devPath(dst.slice(4)))
    target.pipe.end()
    expect(DEC.decode(await consumed)).toBe('through')
  })

  it.each([
    ['cp <(printf hello) /dev/copied; cat /dev/copied', 'hello'],
    ['printf hello > /dev/src; cp /dev/src >(cat); wait', 'hello'],
  ])('cp through a substitution: %s', async (command, expected) => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    try {
      const io = await ws.shell(command)
      expect([io.exitCode, io.stdoutText, io.stderrText]).toEqual([0, expected, ''])
    } finally {
      await ws.close()
    }
  })
})
