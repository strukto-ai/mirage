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
import { IOResult, materialize } from '../../../../io/types.ts'
import { BaseVFS } from '../../../../vfs/base.ts'
import { ContentType, FileStat, FileType, MountMode, PathSpec } from '../../../../types.ts'
import { enoent } from '../../../../utils/errors.ts'
import { MountRegistry } from '../../../../workspace/mount/registry.ts'
import { handleCrossMount, isCrossMount, type RunSingle } from './index.ts'

class Stub extends BaseVFS {
  override readonly name = 'stub'
  override close(): Promise<void> {
    return Promise.resolve()
  }
}

function decode(b: Uint8Array | null): string {
  if (b === null) return ''
  return new TextDecoder().decode(b)
}

describe('isCrossMount', () => {
  const reg = new MountRegistry({ '/ram': new Stub(), '/disk': new Stub() }, MountMode.WRITE)

  it.each([
    ['cp', ['/ram/a', '/disk/b'], true],
    ['unknown', ['/ram/a', '/disk/b'], false],
    ['cp', ['/ram/a', '/ram/b'], false],
    ['cp', ['/ram/a'], false],
  ])('%s %j → %s', (cmd, paths, expected) => {
    expect(
      isCrossMount(
        cmd,
        paths.map((p) => PathSpec.fromStrPath(p)),
        reg,
      ),
    ).toBe(expected)
  })
})

const runSingleNoop: RunSingle = () => Promise.resolve([null, new IOResult()])

function fileStat(name: string): FileStat {
  return new FileStat({ name, size: 0, type: FileType.FILE, content: ContentType.TEXT })
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
        // dst does not exist yet; src is an existing file. The mount root
        // stats as a directory, like every real mount: cp probes the
        // destination's parent before creating anything under it.
        if (p.virtual === '/disk/b') return Promise.reject(enoent(p))
        if (p.virtual === '/disk')
          return Promise.resolve<[unknown, IOResult]>([dirStat('disk'), new IOResult()])
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
    const [, io] = await handleCrossMount('cp', paths, [], {}, dispatch, runSingleNoop, null)
    expect(io.exitCode).toBe(0)
    const ops = dispatch.mock.calls.map((c) => c[0])
    expect(ops).toContain('read')
    expect(ops).toContain('write')
    expect(ops.indexOf('read')).toBeLessThan(ops.indexOf('write'))
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
        // The mount root stats as a directory, like every real mount: cp
        // probes the destination's parent before creating anything under it.
        if (p.virtual === '/disk')
          return Promise.resolve<[unknown, IOResult]>([dirStat('disk'), new IOResult()])
        if (p.virtual === '/disk/b' || p.virtual.startsWith('/disk/'))
          return Promise.reject(enoent(p))
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
        if (p.virtual === '/disk/b') return Promise.reject(enoent(p))
        // The destination's parent is a mount root, which every mount
        // answers as a directory; mv walks the chain of a missing target
        // and a file there would refuse the move as `Not a directory`.
        if (p.virtual === '/disk') {
          return Promise.resolve<[unknown, IOResult]>([dirStat('disk'), new IOResult()])
        }
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
    await handleCrossMount('mv', paths, [], {}, dispatch, runSingleNoop, null)
    const ops = dispatch.mock.calls.map((c) => c[0]).filter((o) => o !== 'stat')
    expect(ops).toEqual(['read', 'write', 'unlink'])
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

  // Per-operand [stdout, exit, stderr?]; stderr present only when the fake
  // operand run actually errored (a grep no-match is exit 1 with no stderr).
  const runSingleFrom =
    (
      perOperand: Record<string, [string, number, string?]>,
      calls: Record<string, unknown>[],
    ): RunSingle =>
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
      if (entry[2] !== undefined) io.stderr = new TextEncoder().encode(entry[2])
      return Promise.resolve([new TextEncoder().encode(entry[0]), io])
    }

  it('plain cat concatenates per-operand pushdown reads without a final run', async () => {
    const calls: Record<string, unknown>[] = []
    const rs = runSingleFrom({ '/ram/a': ['hello\n', 0], '/disk/b': ['world\n', 0] }, calls)
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [out, io] = await handleCrossMount('cat', paths, [], {}, noDispatch, rs, null)
    expect(decode(await materialize(out))).toBe('hello\nworld\n')
    expect(io.exitCode).toBe(0)
    expect(calls.map((c) => c.cmd)).toEqual(['cat', 'cat'])
  })

  it('sort relays independent inputs without native cat sub-runs', async () => {
    const dispatch = vi.fn((op: string, path: PathSpec): Promise<[unknown, IOResult]> =>
      Promise.resolve([
        op === 'stat'
          ? fileStat(path.virtual)
          : new TextEncoder().encode(path.virtual === '/ram/a' ? 'b' : 'a'),
        new IOResult(),
      ]),
    )
    const native = vi.fn(runSingleNoop)
    const paths = [PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')]
    const [out, io] = await handleCrossMount('sort', paths, [], {}, dispatch, native, null)
    expect(io.exitCode).toBe(0)
    expect(decode(await materialize(out))).toBe('a\nb\n')
    expect(dispatch.mock.calls.map(([op]) => op)).toEqual(['stat', 'read', 'stat', 'read'])
    expect(native).not.toHaveBeenCalled()
  })
})
