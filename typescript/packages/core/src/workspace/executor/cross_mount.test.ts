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
import { enoent } from '../../utils/errors.ts'
import { MountRegistry } from '../mount/registry.ts'
import { handleCrossMount, isCrossMount } from './cross_mount.ts'
import type { RunSingle } from '../../commands/builtin/generic/crossmount/index.ts'

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
    expect(isCrossMount('paste', paths, reg)).toBe(false)
  })

  it('returns false when paths share a mount', () => {
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/ram/b')]
    expect(isCrossMount('cp', paths, reg)).toBe(false)
  })

  it('returns false with fewer than 2 paths', () => {
    expect(isCrossMount('cp', [PathSpec.fromStrPath('/ram/a')], reg)).toBe(false)
  })
})

const runSingleNoop: RunSingle = () => Promise.resolve([null, new IOResult()])

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
        if (p.virtual === '/disk/b') return Promise.reject(new Error('ENOENT'))
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
    const [, io, tree] = await handleCrossMount(
      'cp',
      paths,
      [],
      {},
      dispatch,
      runSingleNoop,
      null,
      'cp /ram/a /disk/b',
    )
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
        if (p.virtual === '/disk/b') return Promise.reject(new Error('ENOENT'))
        return Promise.resolve<[unknown, IOResult]>([dirStat('a'), new IOResult()])
      }
      return Promise.resolve<[unknown, IOResult]>([null, new IOResult()])
    })
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [, io] = await handleCrossMount(
      'cp',
      paths,
      [],
      {},
      dispatch,
      runSingleNoop,
      null,
      'cp /ram/a /disk/b',
    )
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
        if (p.virtual === '/disk/b' || p.virtual.startsWith('/disk/'))
          return Promise.reject(new Error('ENOENT'))
        if (p.virtual === '/ram/dir')
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
      runSingleNoop,
      null,
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
        if (p.virtual === '/disk/b') return Promise.reject(new Error('ENOENT'))
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
    await handleCrossMount('mv', paths, [], {}, dispatch, runSingleNoop, null, 'mv')
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
      if (p.virtual.startsWith('/ram'))
        return Promise.resolve<[unknown, IOResult]>([aBytes, new IOResult()])
      return Promise.resolve<[unknown, IOResult]>([bBytes, new IOResult()])
    })
  }

  it('identical contents → exit 0 empty stdout', async () => {
    const d = dispatchWithContents(new TextEncoder().encode('abc'), new TextEncoder().encode('abc'))
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [, io] = await handleCrossMount('cmp', paths, [], {}, d, runSingleNoop, null, 'cmp')
    expect(io.exitCode).toBe(0)
  })

  it('differ at a byte → reports byte index', async () => {
    const d = dispatchWithContents(new TextEncoder().encode('abc'), new TextEncoder().encode('aXc'))
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [out, io] = await handleCrossMount('cmp', paths, [], {}, d, runSingleNoop, null, 'cmp')
    expect(io.exitCode).toBe(1)
    // The shared generic cmp reports "char N, line M" (matching single-mount).
    expect(decode(out as Uint8Array)).toMatch(/char 2/)
  })

  it('EOF on shorter file → exit 1', async () => {
    const d = dispatchWithContents(new TextEncoder().encode('ab'), new TextEncoder().encode('abc'))
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [out, io] = await handleCrossMount('cmp', paths, [], {}, d, runSingleNoop, null, 'cmp')
    expect(io.exitCode).toBe(1)
    expect(decode(out as Uint8Array)).toMatch(/EOF on/)
  })

  it('missing operand → GNU strerror line', async () => {
    const d = vi.fn<
      (
        op: string,
        p: PathSpec,
        args?: readonly unknown[],
        kw?: Record<string, unknown>,
      ) => Promise<[unknown, IOResult]>
    >((_op, p) => {
      if (p.virtual.startsWith('/ram'))
        return Promise.resolve<[unknown, IOResult]>([
          new TextEncoder().encode('abc'),
          new IOResult(),
        ])
      return Promise.reject(enoent(p))
    })
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/missing')]
    const [, io] = await handleCrossMount('cmp', paths, [], {}, d, runSingleNoop, null, 'cmp')
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe(
      'cmp: /disk/missing: No such file or directory\n',
    )
  })
})

describe('handleCrossMount — stream/fanout via runSingle', () => {
  const noDispatch = vi.fn<
    (
      op: string,
      p: PathSpec,
      args?: readonly unknown[],
      kw?: Record<string, unknown>,
    ) => Promise<[unknown, IOResult]>
  >(() => Promise.resolve<[unknown, IOResult]>([null, new IOResult()]))

  const runSingleFrom =
    (perOperand: Record<string, [string, number]>, calls: Record<string, unknown>[]): RunSingle =>
    (cmdName, paths, texts, flagKwargs, opts) => {
      calls.push({
        cmd: cmdName,
        paths: paths.map((p) => p.virtual),
        texts: [...texts],
        flags: { ...flagKwargs },
        resolveHint: opts?.resolveHint?.virtual ?? null,
      })
      const key = paths[0]?.virtual ?? ''
      const entry = perOperand[key] ?? ['', 0]
      const io = new IOResult({ exitCode: entry[1] })
      if (entry[1] !== 0) io.stderr = new TextEncoder().encode(`${cmdName}: ${key}: error\n`)
      return Promise.resolve([new TextEncoder().encode(entry[0]), io])
    }

  it('plain cat concatenates per-operand pushdown reads without a final run', async () => {
    const calls: Record<string, unknown>[] = []
    const rs = runSingleFrom({ '/ram/a': ['hello\n', 0], '/disk/b': ['world\n', 0] }, calls)
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [out, io] = await handleCrossMount('cat', paths, [], {}, noDispatch, rs, null, 'cat')
    expect(decode(await materialize(out))).toBe('hello\nworld\n')
    expect(io.exitCode).toBe(0)
    expect(calls.map((c) => c.cmd)).toEqual(['cat', 'cat'])
  })

  it('sort runs once on the merged stream with a resolve hint', async () => {
    const calls: Record<string, unknown>[] = []
    const perOperand: Record<string, [string, number]> = {
      '/ram/a': ['b\n', 0],
      '/disk/b': ['a\n', 0],
      '': ['a\nb\n', 0],
    }
    const rs = runSingleFrom(perOperand, calls)
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [, io] = await handleCrossMount('sort', paths, [], {}, noDispatch, rs, null, 'sort')
    expect(io.exitCode).toBe(0)
    const final = calls.at(-1)
    expect(final?.cmd).toBe('sort')
    expect(final?.paths).toEqual([])
    expect(final?.resolveHint).toBe('/ram/a')
  })

  it('grep fans out per operand and forces -H', async () => {
    const calls: Record<string, unknown>[] = []
    const rs = runSingleFrom(
      { '/ram/a': ['/ram/a:apple\n', 0], '/disk/b': ['/disk/b:apricot\n', 0] },
      calls,
    )
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [out, io] = await handleCrossMount(
      'grep',
      paths,
      ['ap'],
      {},
      noDispatch,
      rs,
      null,
      'grep',
    )
    expect(io.exitCode).toBe(0)
    const text = decode(await materialize(out))
    expect(text).toBe('/ram/a:apple\n/disk/b:apricot\n')
    expect(calls.every((c) => (c.flags as Record<string, unknown>).H === true)).toBe(true)
  })

  it('rg fans out per operand and forces -H unless -I', async () => {
    const calls: Record<string, unknown>[] = []
    const rs = runSingleFrom(
      { '/ram/a': ['/ram/a:apple\n', 0], '/disk/b': ['/disk/b:apricot\n', 0] },
      calls,
    )
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [, io] = await handleCrossMount('rg', paths, ['ap'], {}, noDispatch, rs, null, 'rg')
    expect(io.exitCode).toBe(0)
    expect(calls.every((c) => (c.flags as Record<string, unknown>).H === true)).toBe(true)

    const calls2: Record<string, unknown>[] = []
    const rs2 = runSingleFrom({ '/ram/a': ['apple\n', 0], '/disk/b': ['apricot\n', 0] }, calls2)
    await handleCrossMount('rg', paths, ['ap'], { args_I: true }, noDispatch, rs2, null, 'rg')
    expect(calls2.every((c) => !('H' in (c.flags as Record<string, unknown>)))).toBe(true)
  })

  it('grep any-match wins over no-match in the merged exit code', async () => {
    const calls: Record<string, unknown>[] = []
    const rs = runSingleFrom({ '/ram/a': ['', 1], '/disk/b': ['/disk/b:x\n', 0] }, calls)
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [, io] = await handleCrossMount('grep', paths, ['x'], {}, noDispatch, rs, null, 'grep')
    expect(io.exitCode).toBe(0)
  })

  it('wc re-totals per-operand rows with one shared width', async () => {
    const calls: Record<string, unknown>[] = []
    const rs = runSingleFrom(
      { '/ram/a': ['2 3 8 /ram/a\n', 0], '/disk/b': ['1 1 2 /disk/b\n', 0] },
      calls,
    )
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [out] = await handleCrossMount('wc', paths, [], {}, noDispatch, rs, null, 'wc')
    const text = decode(await materialize(out))
    expect(text).toBe(' 2  3  8 /ram/a\n 1  1  2 /disk/b\n 3  4 10 total\n')
  })

  it('sha256sum concatenates per-operand lines and fails on any failure', async () => {
    const calls: Record<string, unknown>[] = []
    const rs = runSingleFrom({ '/ram/a': ['', 1], '/disk/b': ['h  /disk/b\n', 0] }, calls)
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [out, io] = await handleCrossMount(
      'sha256sum',
      paths,
      [],
      {},
      noDispatch,
      rs,
      null,
      'sha256sum',
    )
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(out))).toBe('h  /disk/b\n')
  })
})
