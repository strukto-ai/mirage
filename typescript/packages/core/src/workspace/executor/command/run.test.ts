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

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as cacheContextModule from '../../../cache/context.ts'
import type * as ioTypesModule from '../../../io/types.ts'
import { CLISpec } from '../../../commands/cli/types.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { OpRecord } from '../../../observe/record.ts'
import { DEFAULT_COMMAND_LIMITS } from '../../../policy/builtin/output_cap.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { createShellParser } from '../../../shell/parse/index.ts'
import { ops } from '../../../test-utils.ts'
import { Limit, MountMode, PathSpec } from '../../../types.ts'
import { cachingRamWorkspace, captureMarks } from '../../fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace.ts'
import { dropMountCaches } from './run.ts'

const slowWrite = vi.hoisted(() => ({ gate: null as Promise<void> | null, returned: 0 }))

// RAM's write records before it invalidates; holding the invalidation lets a
// write record while the line runs and its command return after the line.
vi.mock('../../../cache/context.ts', async (importOriginal) => {
  const real = await importOriginal<typeof cacheContextModule>()
  return {
    ...real,
    async invalidateAfterWrite(path: PathSpec | string): Promise<void> {
      const gate = slowWrite.gate
      if (gate !== null) await gate
      await real.invalidateAfterWrite(path)
      if (gate !== null) slowWrite.returned += 1
    },
  }
})

const holdMaterialize = vi.hoisted(() => ({ hold: null as (() => Promise<void>) | null }))

// The line materializes its stderr between the seal and persisting its
// records; holding that once lets a background write land in the gap.
vi.mock('../../../io/types.ts', async (importOriginal) => {
  const real = await importOriginal<typeof ioTypesModule>()
  return {
    ...real,
    async materialize(source: Parameters<typeof real.materialize>[0]): Promise<Uint8Array> {
      const hold = holdMaterialize.hold
      if (hold !== null) {
        holdMaterialize.hold = null
        await hold()
      }
      return real.materialize(source)
    },
  }
})

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

function warmWorkspace(): [Workspace, RAMVFS, RAMVFS] {
  const ram = new RAMVFS()
  const other = new RAMVFS()
  // An account CLI's service caches reads, so a body already read is served
  // warm; forcing it on RAM reproduces that without a network backend.
  ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
  ;(other as unknown as { cachesReads: boolean }).cachesReads = true
  const ws = new Workspace(
    { '/r': ram, '/o': other },
    {
      mode: MountMode.WRITE,
      shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
    },
  )
  return [ws, ram, other]
}

async function seed(ram: RAMVFS, other: RAMVFS): Promise<void> {
  await ops(ram).write(PathSpec.fromStrPath('/a.txt'), ENC.encode('v1\n'))
  await ops(other).write(PathSpec.fromStrPath('/b.txt'), ENC.encode('v1\n'))
}

async function warm(ws: Workspace): Promise<void> {
  await ws.shell('cat /r/a.txt')
  await ws.shell('ls /r')
  await ws.shell('cat /o/b.txt')
}

async function mutateOutOfBand(ram: RAMVFS, other: RAMVFS): Promise<void> {
  await ops(ram).write(PathSpec.fromStrPath('/a.txt'), ENC.encode('v2\n'))
  await ops(ram).write(PathSpec.fromStrPath('/new.txt'), ENC.encode('fresh\n'))
  await ops(other).write(PathSpec.fromStrPath('/b.txt'), ENC.encode('v2\n'))
}

async function readBack(ws: Workspace): Promise<[string, string, string]> {
  return [
    DEC.decode((await ws.shell('cat /r/a.txt')).stdout),
    DEC.decode((await ws.shell('ls /r')).stdout),
    DEC.decode((await ws.shell('cat /o/b.txt')).stdout),
  ]
}

describe('dropMountCaches', () => {
  it('drops bodies as well as listings, on every mount', async () => {
    // A stale listing hides a create; a stale body hides an edit. The cached
    // body is the one that answers without reaching the service, so clearing
    // the index alone leaves `cat` serving pre-write content. Which mounts the
    // CLI's service backs is not the CLI's business, so every mount drops.
    const [ws, ram, other] = warmWorkspace()
    try {
      await seed(ram, other)
      await warm(ws)
      expect(DEC.decode((await ws.shell('cat /r/a.txt')).stdout)).toContain('v1')
      await mutateOutOfBand(ram, other)
      await dropMountCaches(ws.registry)
      const [body, listing, otherBody] = await readBack(ws)
      expect(body).toContain('v2')
      expect(listing).toContain('new.txt')
      expect(otherBody).toContain('v2')
    } finally {
      await ws.close()
    }
  })
})

function outOfBandWriter(ram: RAMVFS): () => Promise<[Uint8Array, IOResult]> {
  // A leaf that reaches its service past every mount, as an account CLI does:
  // the file lands in the store, and no vfs path was touched.
  return async () => {
    await ops(ram).write(PathSpec.fromStrPath('/made.txt'), ENC.encode('made\n'))
    return [ENC.encode('ok\n'), new IOResult()]
  }
}

describe('a CLI write and the mount caches', () => {
  it('an account CLI write refreshes every mount', async () => {
    // Nothing on the CLI names the mount and nothing on the mount names the
    // CLI: a write verb on a CLI with a config model is the whole signal.
    const [ws, ram, other] = warmWorkspace()
    try {
      ws.registerCli(
        'acme',
        new CLISpec({
          name: 'acme',
          configModel: (input) => input,
          subcommands: [new CLISpec({ name: 'close', write: true, fn: outOfBandWriter(ram) })],
        }),
        { token: 't' },
      )
      await seed(ram, other)
      await warm(ws)
      await mutateOutOfBand(ram, other)
      expect((await ws.shell('acme close')).exitCode).toBe(0)
      const [body, listing, otherBody] = await readBack(ws)
      expect(body).toContain('v2')
      expect(listing).toContain('made.txt')
      expect(otherBody).toContain('v2')
    } finally {
      await ws.close()
    }
  })

  it('an account CLI read keeps every mount warm', async () => {
    const [ws, ram, other] = warmWorkspace()
    try {
      ws.registerCli(
        'acme',
        new CLISpec({
          name: 'acme',
          configModel: (input) => input,
          subcommands: [new CLISpec({ name: 'peek', fn: outOfBandWriter(ram) })],
        }),
        { token: 't' },
      )
      await seed(ram, other)
      await warm(ws)
      await mutateOutOfBand(ram, other)
      expect((await ws.shell('acme peek')).exitCode).toBe(0)
      // RAM lists its store live, so the cached body is what shows the
      // mount stayed warm.
      const [body, , otherBody] = await readBack(ws)
      expect(body).toContain('v1')
      expect(otherBody).toContain('v1')
    } finally {
      await ws.close()
    }
  })

  it('a mount-tier CLI write drops nothing', async () => {
    // A CLI without a config model (git) writes through the dispatcher, which
    // invalidates the paths it touched as it went; a blanket drop would only
    // cost every other mount a reload.
    const [ws, ram, other] = warmWorkspace()
    try {
      ws.registerCli(
        'tool',
        new CLISpec({
          name: 'tool',
          subcommands: [new CLISpec({ name: 'poke', write: true, fn: outOfBandWriter(ram) })],
        }),
      )
      await seed(ram, other)
      await warm(ws)
      await mutateOutOfBand(ram, other)
      expect((await ws.shell('tool poke')).exitCode).toBe(0)
      const [body, , otherBody] = await readBack(ws)
      expect(body).toContain('v1')
      expect(otherBody).toContain('v1')
    } finally {
      await ws.close()
    }
  })
})

function writesOf(ws: Workspace, path: string): OpRecord[] {
  return ws.records.filter((r) => r.op === 'write' && r.path === path)
}

function claimedOf(ws: Workspace): (ByteSource | null)[] {
  return ws.records.map((r) => r.claimed)
}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`not settled within ${String(ms)}ms`))
    }, ms)
  })
  return Promise.race([work, late]).finally(() => {
    clearTimeout(timer)
  })
}

describe('the provenance mark', () => {
  afterEach(() => {
    delete DEFAULT_COMMAND_LIMITS.sleep
    slowWrite.gate = null
    slowWrite.returned = 0
  })

  it('marks a claimed write with the claimed value', async () => {
    const ws = await cachingRamWorkspace()
    const captured = captureMarks(ws)
    try {
      expect((await ws.shell('echo a | tee /r/f')).exitCode).toBe(0)
    } finally {
      await ws.close()
    }
    expect(captured).toHaveLength(1)
    const [marks, writes] = captured[0] ?? [[], {} as Record<string, ByteSource>]
    const claimed = marks.filter(([op, path]) => op === 'write' && path === '/r/f')
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.[2]).toBe(writes['/r/f'])
  })

  it.each([
    ['finished', 'echo a | tee /r/f', 0],
    ['timed out', 'echo a | tee /r/f; sleep 2', 124],
  ])('leaves no record marked after a line that %s', async (_, line, exitCode) => {
    DEFAULT_COMMAND_LIMITS.sleep = new Limit({ timeoutSeconds: 0.1 })
    const ws = await cachingRamWorkspace()
    try {
      expect((await ws.shell(line)).exitCode).toBe(exitCode)
      expect(writesOf(ws, '/r/f').length).toBeGreaterThan(0)
      expect(claimedOf(ws)).toEqual(ws.records.map(() => null))
    } finally {
      await ws.close()
    }
  })

  it('clears a background write marked after the seal', async () => {
    const [ws, ram] = warmWorkspace()
    const applied: (readonly OpRecord[])[] = []
    const dispatcher = (
      ws as unknown as {
        dispatcher: { applyIo: (io: IOResult, records?: readonly OpRecord[]) => Promise<void> }
      }
    ).dispatcher
    const orig = dispatcher.applyIo.bind(dispatcher)
    dispatcher.applyIo = async (io, records) => {
      await orig(io, records)
      applied.push(records ?? [])
      if (applied.length !== 1) return
      holdMaterialize.hold = async () => {
        await ops(ram).write(PathSpec.fromStrPath('/go'), ENC.encode('go'))
        for (let i = 0; i < 500 && !applied[0]?.some((r) => r.claimed != null); i++)
          await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    try {
      const line = '{ until [ -e /r/go ]; do sleep 0.01; done; echo a | tee /r/f; } &'
      expect((await within(ws.shell(line), 10_000)).exitCode).toBe(0)
      expect((await ws.shell('wait')).exitCode).toBe(0)
      expect(writesOf(ws, '/r/f').length).toBeGreaterThan(0)
      expect(claimedOf(ws)).toEqual(ws.records.map(() => null))
    } finally {
      holdMaterialize.hold = null
      await ws.close()
    }
  }, 15_000)

  it('a background claimer ending after the line marks nothing', async () => {
    // The background tee's write records while the line still runs (RAM
    // stores the bytes and records before it invalidates, with no await
    // between, so the loop sees the record once it sees the bytes), and the
    // line persists that record; the tee itself returns only after the gate
    // opens, past the line's end, when its scope is sealed.
    let open: () => void = () => undefined
    slowWrite.gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const ws = await cachingRamWorkspace()
    try {
      const line = 'echo a | tee /r/f & until [ -s /r/f ]; do sleep 0.01; done'
      expect((await within(ws.shell(line), 5000)).exitCode).toBe(0)
      expect(writesOf(ws, '/r/f').length).toBeGreaterThan(0)
      open()
      expect((await ws.shell('wait')).exitCode).toBe(0)
      expect(slowWrite.returned).toBe(1)
      expect(claimedOf(ws)).toEqual(ws.records.map(() => null))
    } finally {
      open()
      await ws.close()
    }
  }, 10_000)
})
