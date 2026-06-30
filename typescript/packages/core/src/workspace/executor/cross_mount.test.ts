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

import { describe, expect, it, vi } from 'vitest'
import { IOResult, materialize } from '../../io/types.ts'
import type { Resource } from '../../resource/base.ts'
import { FileStat, FileType, MountMode, PathSpec } from '../../types.ts'
import { MountRegistry } from '../mount/registry.ts'
import { handleCrossMount, isCrossMount } from './cross_mount.ts'

class Stub implements Resource {
  readonly kind = 'stub'
  open(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

function decode(b: Uint8Array | null): string {
  if (b === null) return ''
  return new TextDecoder().decode(b)
}

describe('isCrossMount', () => {
  const reg = new MountRegistry({ '/ram': new Stub(), '/disk': new Stub() }, MountMode.WRITE)

  it('returns true when 2 paths live in different mounts and command is allowed', () => {
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    expect(isCrossMount('cp', paths, reg)).toBe(true)
  })

  it('returns false for non-cross-mount commands', () => {
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    expect(isCrossMount('ls', paths, reg)).toBe(false)
  })

  it('returns false when paths share a mount', () => {
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/ram/b')]
    expect(isCrossMount('cp', paths, reg)).toBe(false)
  })

  it('returns false with fewer than 2 paths', () => {
    expect(isCrossMount('cp', [PathSpec.fromStrPath('/ram/a')], reg)).toBe(false)
  })
})

function fileStat(name: string): FileStat {
  return new FileStat({ name, size: 0, type: FileType.TEXT })
}

function dirStat(name: string): FileStat {
  return new FileStat({ name, size: 0, type: FileType.DIRECTORY })
}

describe('handleCrossMount — cp / mv', () => {
  it('cp reads src then writes dst', async () => {
    const dispatch = vi.fn<
      (
        op: string,
        p: PathSpec,
        args?: readonly unknown[],
        kw?: Record<string, unknown>,
      ) => Promise<[unknown, IOResult]>
    >((op, p) => {
      if (op === 'stat') {
        // dst does not exist yet; src is an existing file.
        if (p.original === '/disk/b') return Promise.reject(new Error('ENOENT'))
        return Promise.resolve<[unknown, IOResult]>([fileStat('a'), new IOResult()])
      }
      if (op === 'read')
        return Promise.resolve<[unknown, IOResult]>([
          new TextEncoder().encode('payload'),
          new IOResult(),
        ])
      return Promise.resolve<[unknown, IOResult]>([null, new IOResult()])
    })
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [, io, tree] = await handleCrossMount('cp', paths, [], {}, dispatch, 'cp /ram/a /disk/b')
    expect(io.exitCode).toBe(0)
    expect(tree.exitCode).toBe(0)
    const ops = dispatch.mock.calls.map((c) => c[0])
    expect(ops).toContain('read')
    expect(ops).toContain('write')
    expect(ops.indexOf('read')).toBeLessThan(ops.indexOf('write'))
  })

  it('cp of a directory without -r is an omitting-directory error', async () => {
    const dispatch = vi.fn<
      (
        op: string,
        p: PathSpec,
        args?: readonly unknown[],
        kw?: Record<string, unknown>,
      ) => Promise<[unknown, IOResult]>
    >((op, p) => {
      if (op === 'stat') {
        if (p.original === '/disk/b') return Promise.reject(new Error('ENOENT'))
        return Promise.resolve<[unknown, IOResult]>([dirStat('a'), new IOResult()])
      }
      return Promise.resolve<[unknown, IOResult]>([null, new IOResult()])
    })
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [, io] = await handleCrossMount('cp', paths, [], {}, dispatch, 'cp /ram/a /disk/b')
    expect(io.exitCode).toBe(1)
    expect(dispatch.mock.calls.some((c) => c[0] === 'write')).toBe(false)
  })

  it('cp -r recurses a directory: mkdir dst, then copy each file', async () => {
    const dispatch = vi.fn<
      (
        op: string,
        p: PathSpec,
        args?: readonly unknown[],
        kw?: Record<string, unknown>,
      ) => Promise<[unknown, IOResult]>
    >((op, p) => {
      if (op === 'stat') {
        if (p.original === '/disk/b' || p.original.startsWith('/disk/'))
          return Promise.reject(new Error('ENOENT'))
        if (p.original === '/ram/dir')
          return Promise.resolve<[unknown, IOResult]>([dirStat('dir'), new IOResult()])
        return Promise.resolve<[unknown, IOResult]>([fileStat('f'), new IOResult()])
      }
      if (op === 'readdir')
        return Promise.resolve<[unknown, IOResult]>([['/ram/dir/a.txt'], new IOResult()])
      if (op === 'read')
        return Promise.resolve<[unknown, IOResult]>([new TextEncoder().encode('x'), new IOResult()])
      return Promise.resolve<[unknown, IOResult]>([null, new IOResult()])
    })
    const paths = [PathSpec.fromStrPath('/ram/dir'), PathSpec.fromStrPath('/disk/b')]
    const [, io] = await handleCrossMount(
      'cp',
      paths,
      [],
      { r: true },
      dispatch,
      'cp -r /ram/dir /disk/b',
    )
    expect(io.exitCode).toBe(0)
    const ops = dispatch.mock.calls.map((c) => c[0])
    expect(ops).toContain('mkdir')
    expect(ops).toContain('write')
  })

  it('mv reads src, writes dst, then unlinks src', async () => {
    const dispatch = vi.fn<
      (
        op: string,
        p: PathSpec,
        args?: readonly unknown[],
        kw?: Record<string, unknown>,
      ) => Promise<[unknown, IOResult]>
    >((op, p) => {
      if (op === 'stat') {
        if (p.original === '/disk/b') return Promise.reject(new Error('ENOENT'))
        return Promise.resolve<[unknown, IOResult]>([fileStat('a'), new IOResult()])
      }
      if (op === 'read')
        return Promise.resolve<[unknown, IOResult]>([
          new TextEncoder().encode('data'),
          new IOResult(),
        ])
      return Promise.resolve<[unknown, IOResult]>([null, new IOResult()])
    })
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    await handleCrossMount('mv', paths, [], {}, dispatch, 'mv')
    const ops = dispatch.mock.calls.map((c) => c[0]).filter((o) => o !== 'stat')
    expect(ops).toEqual(['read', 'write', 'unlink'])
  })
})

describe('handleCrossMount — cmp', () => {
  function dispatchWithContents(aBytes: Uint8Array, bBytes: Uint8Array) {
    return vi.fn<
      (
        op: string,
        p: PathSpec,
        args?: readonly unknown[],
        kw?: Record<string, unknown>,
      ) => Promise<[unknown, IOResult]>
    >((_op, p) => {
      if (p.original.startsWith('/ram'))
        return Promise.resolve<[unknown, IOResult]>([aBytes, new IOResult()])
      return Promise.resolve<[unknown, IOResult]>([bBytes, new IOResult()])
    })
  }

  it('identical contents → exit 0 empty stdout', async () => {
    const d = dispatchWithContents(new TextEncoder().encode('abc'), new TextEncoder().encode('abc'))
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [, io] = await handleCrossMount('cmp', paths, [], {}, d, 'cmp')
    expect(io.exitCode).toBe(0)
  })

  it('differ at a byte → reports byte index', async () => {
    const d = dispatchWithContents(new TextEncoder().encode('abc'), new TextEncoder().encode('aXc'))
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [out, io] = await handleCrossMount('cmp', paths, [], {}, d, 'cmp')
    expect(io.exitCode).toBe(1)
    // The shared generic cmp reports "char N, line M" (matching single-mount).
    expect(decode(out as Uint8Array)).toMatch(/char 2/)
  })

  it('EOF on shorter file → exit 1', async () => {
    const d = dispatchWithContents(new TextEncoder().encode('ab'), new TextEncoder().encode('abc'))
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [out, io] = await handleCrossMount('cmp', paths, [], {}, d, 'cmp')
    expect(io.exitCode).toBe(1)
    expect(decode(out as Uint8Array)).toMatch(/EOF on/)
  })
})

describe('handleCrossMount — multi-read cat/head/tail/grep/wc', () => {
  const dispatchTwo = (aStr: string, bStr: string) =>
    vi.fn<
      (
        op: string,
        p: PathSpec,
        args?: readonly unknown[],
        kw?: Record<string, unknown>,
      ) => Promise<[unknown, IOResult]>
    >((_op, p) => {
      if (p.original.startsWith('/ram'))
        return Promise.resolve<[unknown, IOResult]>([
          new TextEncoder().encode(aStr),
          new IOResult(),
        ])
      return Promise.resolve<[unknown, IOResult]>([new TextEncoder().encode(bStr), new IOResult()])
    })

  it('cat concatenates contents', async () => {
    const d = dispatchTwo('hello\n', 'world\n')
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [out] = await handleCrossMount('cat', paths, [], {}, d, 'cat')
    expect(decode(await materialize(out))).toBe('hello\nworld\n')
  })

  it('head -n 2 keeps first N lines per file with headers on multi-file', async () => {
    const d = dispatchTwo('1\n2\n3\n', 'x\ny\nz\n')
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    // The executor parses flags before routing, so -n arrives as a flag kwarg.
    const [out] = await handleCrossMount('head', paths, [], { n: '2' }, d, 'head')
    const text = decode(await materialize(out))
    expect(text).toMatch(/==> \/ram\/a <==/)
    expect(text).toMatch(/1\n2/)
    expect(text).toMatch(/==> \/disk\/b <==/)
    expect(text).toMatch(/x\ny/)
  })

  it('grep emits "name:line" for matches', async () => {
    const d = dispatchTwo('apple\nbanana\n', 'apricot\n')
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [out, io] = await handleCrossMount('grep', paths, ['ap'], {}, d, 'grep')
    expect(io.exitCode).toBe(0)
    const text = decode(out as Uint8Array)
    expect(text).toMatch(/\/ram\/a:apple/)
    expect(text).toMatch(/\/disk\/b:apricot/)
  })

  it('grep returns exit 1 and no output when nothing matches', async () => {
    const d = dispatchTwo('x\n', 'y\n')
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [, io] = await handleCrossMount('grep', paths, ['zzz'], {}, d, 'grep')
    expect(io.exitCode).toBe(1)
  })

  it('wc defaults to lines/words/chars per file', async () => {
    const d = dispatchTwo('a b\nc\n', 'x\n')
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [out] = await handleCrossMount('wc', paths, [], {}, d, 'wc')
    const text = decode(out as Uint8Array)
    expect(text).toMatch(/2 3 \d+ \/ram\/a/)
    expect(text).toMatch(/1 1 \d+ \/disk\/b/)
  })
})
