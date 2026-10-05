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

import { expect, it } from 'vitest'
import { commandStarted, runInCommandScope } from '../../../cache/index/scope.ts'
import { command } from '../../config.ts'
import { SPECS } from '../../spec/index.ts'
import { IOResult } from '../../../io/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { runDispatch } from './dispatch.ts'
import { FileType, MountMode, PathSpec } from '../../../types.ts'
import type { RegisteredOp } from '../../../ops/registry.ts'
import { eacces } from '../../../utils/errors.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'

it('reads the output inside the running command', async () => {
  // A fresh mount trusts only the listings the running command made, so a
  // walk read lazily after the command ended was served stale ones.
  const seen: (number | null)[] = []
  async function* walk(): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    seen.push(commandStarted())
    yield new TextEncoder().encode('hit\n')
  }
  const dispatch = (() => Promise.reject(new Error('no op'))) as unknown as DispatchFn
  const [started, stdout] = await runInCommandScope(async () => [
    commandStarted(),
    (
      await runDispatch(
        { name: 'grep', fn: () => [walk(), new IOResult()] },
        [],
        [],
        {},
        dispatch,
        '/',
      )
    )[0],
  ])
  expect([new TextDecoder().decode(stdout as Uint8Array), seen]).toEqual(['hit\n', [started]])
})

class CachedRAM extends RAMVFS {
  override readonly cachesReads = true
}

it.each([false, true])(
  'caches relayed inputs and replacements (overwrite=%s)',
  async (overwrite) => {
    const enc = new TextEncoder()
    const left = new CachedRAM()
    const right = new CachedRAM()
    left.loadState({ type: 'ram', files: { '/input': enc.encode('z\na\n') } })
    right.loadState({ type: 'ram', files: { '/input': enc.encode('m\n') } })
    const ws = new Workspace(
      { '/a': left, '/b': right },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    const command = 'sort /a/input /b/input'
    try {
      const result = await ws.shell(command + (overwrite ? ' -o /a/input' : ''))
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toEqual(enc.encode(overwrite ? '' : 'a\nm\nz\n'))
      expect(await ws.cache.get('/a/input')).toEqual(enc.encode(overwrite ? 'a\nm\nz\n' : 'z\na\n'))
      expect(await ws.cache.get('/b/input')).toEqual(enc.encode('m\n'))
      left.loadState({ type: 'ram', files: { '/input': enc.encode('changed\n') } })
      const again = await ws.shell(overwrite ? 'cat /a/input' : command)
      expect(again.stdout).toEqual(enc.encode('a\nm\nz\n'))
    } finally {
      await ws.close()
    }
  },
)

it('lists nothing it read through the dispatcher for the file cache', async () => {
  // The dispatcher's cold read keeps what the file cache may hold; listed
  // again, a filetype renderer's output would be kept under the path.
  const path = PathSpec.fromStrPath('/a/f.tally')
  const dispatch = ((op: string) =>
    Promise.resolve([
      op === 'stat' ? { type: FileType.FILE } : new TextEncoder().encode('RENDERED'),
      new IOResult(),
    ])) as unknown as DispatchFn
  const [, io] = await runDispatch(
    {
      name: 'cat',
      fn: async (ops, accessor, paths) => {
        const [operand] = paths
        if (operand === undefined) throw new Error('no operand')
        await ops.readBytes(accessor, operand)
        return [null, new IOResult({ cache: [operand.mountPath] })]
      },
    },
    [path],
    [],
    {},
    dispatch,
    '/',
  )
  expect(Object.keys(io.reads)).toEqual([path.virtual])
  expect(io.cache).toEqual([])
})

class Uncapped extends RAMVFS {
  override readonly maxDuEntries = null
}

class Capped extends RAMVFS {
  override readonly maxDuEntries = 2
}

it('charges each mount its own cap in a du walk', async () => {
  // A du that reports no measurement leaves the line to this walk.
  const enc = new TextEncoder()
  const outer = new Uncapped()
  const inner = new Capped()
  for (let i = 0; i < 4; i++) outer.store.files.set(`/f${String(i)}`, enc.encode('x'))
  for (let i = 0; i < 3; i++) inner.store.files.set(`/g${String(i)}`, enc.encode('y'))
  const ws = new Workspace(
    { '/a': outer, '/a/b': inner },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  const spec = SPECS.du
  if (spec === undefined) throw new Error('Missing spec: du')
  for (const cmd of command({
    name: 'du',
    vfs: 'ram',
    spec,
    fn: (_accessor, paths) => [enc.encode(`0\t${paths[0]?.rawPath ?? ''}\n`), new IOResult()],
  }))
    ws.registry.mountFor('/a/b/x').register(cmd)
  try {
    const result = await ws.shell('du -a /a')
    const rows = new TextDecoder().decode(result.stdout).split('\n')
    expect(rows.filter((r) => r.includes('/a/f'))).toEqual(
      [0, 1, 2, 3].map((i) => `1\t/a/f${String(i)}`),
    )
    expect(rows.filter((r) => r.includes('/a/b/g'))).toHaveLength(2)
    expect(new TextDecoder().decode(result.stderr)).toBe(
      'du: walk stopped early: the reported sizes are incomplete\n',
    )
    expect(result.exitCode).toBe(1)
  } finally {
    await ws.close()
  }
})

class RefusedListing extends RAMVFS {
  override ops(): readonly RegisteredOp[] {
    return super
      .ops()
      .map((ro) =>
        ro.name === 'readdir'
          ? { ...ro, fn: (_a: unknown, path: PathSpec) => Promise.reject(eacces(path)) }
          : ro,
      )
  }
}

it('du -x never lists a mount below the operand', async () => {
  const ws = new Workspace(
    { '/a': new RAMVFS(), '/a/b': new RefusedListing(), '/c': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    await ws.shell('echo aa > /a/f; echo d > /c/h')
    const result = await ws.shell('du -x /a /c')
    expect(new TextDecoder().decode(result.stdout)).toBe('3\t/a\n2\t/c\n')
    expect(new TextDecoder().decode(result.stderr)).toBe('')
    expect(result.exitCode).toBe(0)
  } finally {
    await ws.close()
  }
})
