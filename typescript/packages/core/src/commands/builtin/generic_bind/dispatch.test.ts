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
import { type FileStat, MountMode, type PathSpec } from '../../../types.ts'
import { BaseVFS } from '../../../vfs/base.ts'
import type { Handed } from '../../../vfs/types.ts'
import { eacces } from '../../../errors/fs.ts'
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
  override readdir(path: PathSpec): Promise<FileStat[]> {
    return Promise.reject(eacces(path))
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

// A RAM mount that answers the read stand-ins on its own. Mirrors `_Lines`
// in test_dispatch.py.
class Lines extends RAMVFS {
  readonly asked: string[] = []

  override firstLines(_path: PathSpec, n: number, _handed?: Handed): Promise<Uint8Array> {
    this.asked.push(`firstLines ${String(n)}`)
    return Promise.resolve(new TextEncoder().encode('first\n'.repeat(n)))
  }

  override lastLines(_path: PathSpec, n: number, _handed?: Handed): Promise<Uint8Array> {
    this.asked.push(`lastLines ${String(n)}`)
    return Promise.resolve(new TextEncoder().encode('last\n'.repeat(n)))
  }

  override lineCount(_path: PathSpec, _handed?: Handed): Promise<number> {
    this.asked.push('lineCount')
    return Promise.resolve(42)
  }
}

class CachedLines extends Lines {
  override readonly cachesReads = true
}

function lines<T extends Lines>(vfs: T): T {
  vfs.loadState({ type: 'ram', files: { '/f': new TextEncoder().encode('a\nb\nc\n') } })
  return vfs
}

it('asks the mount for head, tail and wc through the dispatcher', async () => {
  const vfs = lines(new Lines())
  const ws = new Workspace({ '/m': vfs }, { shellParser: await getTestParser() })
  const dec = new TextDecoder()
  try {
    const out = [
      dec.decode((await ws.shell('head -n 2 /m/f')).stdout),
      dec.decode((await ws.shell('tail -n 1 /m/f')).stdout),
      dec.decode((await ws.shell('wc -l /m/f')).stdout),
    ]
    expect(out).toEqual(['first\nfirst\n', 'last\n', '42 /m/f\n'])
    expect(vfs.asked).toEqual(['firstLines 2', 'lastLines 1', 'lineCount'])
  } finally {
    await ws.close()
  }
})

it('refuses the stand-ins through a link to a sealed file', async () => {
  const vfs = lines(new Lines())
  const ws = new Workspace(
    { '/m': vfs },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    expect((await ws.shell('ln -s /m/f /m/l')).exitCode).toBe(0)
    await ws.setSessionProfile(ws.defaultSessionId, {
      commands: { deny: [{ paths: ['/m/f'], reason: 'sealed' }] },
    })
    for (const line of ['head -n 2 /m/l', 'tail -n 1 /m/l', 'wc -l /m/l']) {
      const refused = await ws.shell(line)
      expect(refused.exitCode).toBe(1)
      expect(new TextDecoder().decode(refused.stderr)).toContain('Permission denied')
    }
    expect(vfs.asked).toEqual([])
  } finally {
    await ws.close()
  }
})

it('reads a cached file from the cache instead', async () => {
  const vfs = lines(new CachedLines())
  const ws = new Workspace({ '/m': vfs }, { shellParser: await getTestParser() })
  const dec = new TextDecoder()
  try {
    await ws.shell('cat /m/f')
    const out = [
      dec.decode((await ws.shell('head -n 2 /m/f')).stdout),
      dec.decode((await ws.shell('tail -n 1 /m/f')).stdout),
      dec.decode((await ws.shell('wc -l /m/f')).stdout),
    ]
    expect(out).toEqual(['a\nb\n', 'c\n', '3 /m/f\n'])
    expect(vfs.asked).toEqual([])
  } finally {
    await ws.close()
  }
})

// A RAM mount that counts its listings. Mirrors `_Counted` in test_dispatch.py.
class Counted extends RAMVFS {
  trees = 0
  listings = 0

  override readTree(path: PathSpec): Promise<Map<string, FileStat> | null> {
    this.trees += 1
    return super.readTree(path)
  }

  override readdir(path: PathSpec): Promise<FileStat[]> {
    this.listings += 1
    return super.readdir(path)
  }
}

// A RAM mount without readTree: every walk lists each directory.
class Untreed extends RAMVFS {}
// eslint-disable-next-line @typescript-eslint/unbound-method
Object.defineProperty(Untreed.prototype, 'readTree', { value: BaseVFS.prototype.readTree })

const WALKS = [
  'find /m',
  'find /m -maxdepth 1',
  'find /m -type d',
  'find /m -empty',
  'du -a /m',
  'du -s /m/a',
  'ls -R /m',
  'ls -lR /m/a',
  'tree /m',
  'tree -L 1 /m',
  'grep -r ada /m',
  'rg ada /m',
  'cp -r /m/a /m/copy && find /m/copy',
]

async function walks(vfs: RAMVFS): Promise<[number, string, string][]> {
  const enc = new TextEncoder()
  vfs.loadState({
    type: 'ram',
    files: {
      '/a/x.txt': enc.encode('ada\n'),
      '/a/b/y.py': enc.encode('print(1)\n'),
      '/a/b/c/z.md': enc.encode('ada lovelace\n'),
      '/top': enc.encode('t\n'),
    },
  })
  for (const dir of ['/a', '/a/b', '/a/b/c', '/a/empty']) vfs.store.dirs.add(dir)
  const ws = new Workspace(
    { '/m': vfs },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  const dec = new TextDecoder()
  try {
    const out: [number, string, string][] = []
    for (const line of WALKS) {
      const r = await ws.shell(line)
      out.push([r.exitCode, dec.decode(r.stdout), dec.decode(r.stderr)])
    }
    return out
  } finally {
    await ws.close()
  }
}

it('reads a walked tree in one call and prints the same', async () => {
  const counted = new Counted()
  expect(await walks(counted)).toEqual(await walks(new Untreed()))
  expect(counted.trees).toBeGreaterThan(0)
  // find -maxdepth 1 and tree -L 1 each list their one level.
  expect(counted.listings).toBe(2)
})
