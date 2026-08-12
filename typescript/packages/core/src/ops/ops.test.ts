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
import { runWithSession } from '../context/session_context.ts'
import { LimitExceededError } from '../commands/builtin/utils/limit.ts'
import { OpsRegistry } from './registry.ts'
import type { Policy } from '../policy/base.ts'
import { PolicyDenied, PolicyError } from '../policy/errors.ts'
import type { Action, OpsContext, OpsResultContext } from '../policy/types.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { FileType, Limit, MountMode, OnExceed } from '../types.ts'
import { enotdir } from '../utils/errors.ts'
import { Workspace } from '../workspace/workspace.ts'

const DEC = new TextDecoder()

function mkWorkspace(): Workspace {
  const resource = new RAMResource()
  const ops = new OpsRegistry()
  for (const op of resource.ops()) ops.register(op)
  return new Workspace({ '/data': resource }, { mode: MountMode.WRITE, ops })
}

// The Workspace constructor re-registers each mount's ops, so the failing
// stat has to land on the registry after the workspace is built.
function mkFailingStat(err: unknown): Workspace {
  const resource = new RAMResource()
  const ops = new OpsRegistry()
  for (const op of resource.ops()) ops.register(op)
  const ws = new Workspace({ '/data': resource }, { mode: MountMode.WRITE, ops })
  ops.register({
    name: 'stat',
    resource: resource.kind,
    filetype: null,
    fn: () => {
      throw err
    },
    write: false,
  })
  return ws
}

describe('Ops', () => {
  it('writeFile + readFile round-trips bytes', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/a.txt', 'hello')
    const text = await ws.fs.readFileText('/data/a.txt')
    expect(text).toBe('hello')
  })

  it('writeFile accepts Uint8Array', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/b.bin', new Uint8Array([1, 2, 3]))
    const bytes = await ws.fs.readFile('/data/b.bin')
    expect([...bytes]).toEqual([1, 2, 3])
  })

  it('mkdir + readdir lists entries', async () => {
    const ws = mkWorkspace()
    await ws.fs.mkdir('/data/sub')
    await ws.fs.writeFile('/data/sub/x.txt', 'x')
    await ws.fs.writeFile('/data/sub/y.txt', 'y')
    const entries = await ws.fs.readdir('/data/sub')
    expect(entries.sort()).toEqual(['/data/sub/x.txt', '/data/sub/y.txt'])
  })

  it('append extends a file through the append op (the python facade has it too)', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/log.txt', 'head')
    await ws.fs.append('/data/log.txt', new TextEncoder().encode('-tail'))
    expect(await ws.fs.readFileText('/data/log.txt')).toBe('head-tail')
    expect(ws.records.map((r) => r.op)).toContain('append')
  })

  it('exists returns true for existing files and dirs', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/hi.txt', 'hi')
    await ws.fs.mkdir('/data/dir')
    expect(await ws.fs.exists('/data/hi.txt')).toBe(true)
    expect(await ws.fs.exists('/data/dir')).toBe(true)
    expect(await ws.fs.exists('/data/nope')).toBe(false)
  })

  it('isDir distinguishes files from directories', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/file.txt', 'x')
    await ws.fs.mkdir('/data/dir')
    expect(await ws.fs.isDir('/data/dir')).toBe(true)
    expect(await ws.fs.isDir('/data/file.txt')).toBe(false)
    expect(await ws.fs.isFile('/data/file.txt')).toBe(true)
    expect(await ws.fs.isFile('/data/dir')).toBe(false)
  })

  it('stat returns size', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/a.txt', 'hello')
    const s = await ws.fs.stat('/data/a.txt')
    expect(s.size).toBe(5)
  })

  it('unlink removes file', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/gone.txt', 'x')
    expect(await ws.fs.exists('/data/gone.txt')).toBe(true)
    await ws.fs.unlink('/data/gone.txt')
    expect(await ws.fs.exists('/data/gone.txt')).toBe(false)
  })

  it('cat reads file as string', async () => {
    const ws = mkWorkspace()
    await ws.fs.writeFile('/data/t.txt', 'content')
    expect(await ws.fs.cat('/data/t.txt')).toBe('content')
  })
})

describe('Ops existence probes', () => {
  it('report false for a missing path', async () => {
    const ws = mkWorkspace()
    expect(await ws.fs.exists('/data/nope')).toBe(false)
    expect(await ws.fs.isDir('/data/nope')).toBe(false)
    expect(await ws.fs.isFile('/data/nope')).toBe(false)
  })

  it('report false for a path outside every mount', async () => {
    const ws = mkWorkspace()
    expect(await ws.fs.exists('/nowhere/x')).toBe(false)
    expect(await ws.fs.isDir('/nowhere/x')).toBe(false)
    expect(await ws.fs.isFile('/nowhere/x')).toBe(false)
  })

  it('propagate a backend failure instead of reporting it as missing', async () => {
    const ws = mkFailingStat(new Error('401 Unauthorized'))
    await expect(ws.fs.exists('/data/a.txt')).rejects.toThrow('401 Unauthorized')
    await expect(ws.fs.isDir('/data/a.txt')).rejects.toThrow('401 Unauthorized')
    await expect(ws.fs.isFile('/data/a.txt')).rejects.toThrow('401 Unauthorized')
  })

  it('propagate a non-ENOENT fs error, matching Python which swallows only two', async () => {
    const ws = mkFailingStat(enotdir('/data/a.txt'))
    await expect(ws.fs.exists('/data/a.txt')).rejects.toThrow('/data/a.txt')
    await expect(ws.fs.isDir('/data/a.txt')).rejects.toThrow('/data/a.txt')
    await expect(ws.fs.isFile('/data/a.txt')).rejects.toThrow('/data/a.txt')
  })
})

// The fs facade is an op door like the dispatcher: FUSE and programmatic
// access read through it, so policy hooks must fire here too.
describe('Ops policy door', () => {
  class SealReads implements Policy {
    preOps(ctx: OpsContext): Action | null {
      if (!ctx.write && ctx.path.virtual.endsWith('.sealed')) {
        return { kind: 'deny', message: 'sealed\n' }
      }
      return null
    }
  }

  class RedactReads implements Policy {
    postOps(ctx: OpsResultContext): Action | null {
      const data = ctx.result instanceof Uint8Array ? ctx.result : null
      if (ctx.op === 'read' && data !== null && DEC.decode(data).includes('TOPSECRET')) {
        return { kind: 'deny', message: 'redacted\n' }
      }
      return null
    }
  }

  class CapReads implements Policy {
    postOps(ctx: OpsResultContext): Action | null {
      if (ctx.op === 'read' && ctx.path.virtual.endsWith('.log')) {
        return new Limit({ maxBytes: 5 })
      }
      return null
    }
  }

  class LockWrites implements Policy {
    preOps(ctx: OpsContext): Action | null {
      if (ctx.write && ctx.path.virtual.startsWith('/data/locked/')) {
        return { kind: 'deny', message: 'locked\n' }
      }
      return null
    }
  }

  function mkGuarded(): Workspace {
    const resource = new RAMResource()
    const ops = new OpsRegistry()
    for (const op of resource.ops()) ops.register(op)
    return new Workspace(
      { '/data': resource },
      {
        mode: MountMode.WRITE,
        ops,
        policies: [new SealReads(), new RedactReads(), new CapReads(), new LockWrites()],
      },
    )
  }

  it('preOps denies a read through the facade with EACCES', async () => {
    const ws = mkGuarded()
    await ws.fs.writeFile('/data/x.sealed', 'nope\n')
    await expect(ws.fs.readFile('/data/x.sealed')).rejects.toThrow(PolicyDenied)
  })

  it('postOps denies on result content the pre hook cannot see', async () => {
    const ws = mkGuarded()
    await ws.fs.writeFile('/data/secret.txt', 'TOPSECRET plans\n')
    await expect(ws.fs.readFile('/data/secret.txt')).rejects.toThrow(PolicyDenied)
    await ws.fs.writeFile('/data/clean.txt', 'hello\n')
    expect(await ws.fs.readFileText('/data/clean.txt')).toBe('hello\n')
  })

  it('postOps Limit caps facade read bytes', async () => {
    const ws = mkGuarded()
    await ws.fs.writeFile('/data/big.log', 'abcdefghij\n')
    expect(DEC.decode(await ws.fs.readFile('/data/big.log'))).toBe('abcde')
  })

  it('preOps denies a facade write before the backend runs', async () => {
    const ws = mkGuarded()
    await expect(ws.fs.writeFile('/data/locked/f.txt', 'hi')).rejects.toThrow(PolicyDenied)
    expect(await ws.fs.exists('/data/locked/f.txt')).toBe(false)
  })
})

// The facade is not a second pipeline: it hands every op to the
// dispatcher, so what the shell sees and what ws.fs sees cannot drift,
// and each gate fires exactly once per op.
describe('Ops is one door with the dispatcher', () => {
  class CountPre implements Policy {
    readonly seen: string[] = []
    preOps(ctx: OpsContext): Action | null {
      this.seen.push(`${ctx.op}:${ctx.prefix}`)
      return null
    }
  }

  it('fires each admission gate exactly once per op', async () => {
    const counter = new CountPre()
    const resource = new RAMResource()
    const ops = new OpsRegistry()
    for (const op of resource.ops()) ops.register(op)
    const ws = new Workspace(
      { '/data': resource },
      { mode: MountMode.WRITE, ops, policies: [counter] },
    )
    await ws.fs.writeFile('/data/a.txt', 'hello')
    await ws.fs.readFile('/data/a.txt')
    expect(counter.seen).toEqual(['write:/data/', 'read:/data/'])
  })

  class DenyInner implements Policy {
    postOps(ctx: OpsResultContext): Action | null {
      if (ctx.path.virtual === '/m/inner') return { kind: 'deny', message: 'no\n' }
      return null
    }
  }

  it('serves the namespace structure a nested mount implies', async () => {
    // '/data/inner' is served by no backend: it exists only because a
    // mount sits below it. The dispatcher answers it, so the facade
    // does too.
    const outer = new RAMResource()
    const inner = new RAMResource()
    const ops = new OpsRegistry()
    ops.registerResource(outer)
    ops.registerResource(inner)
    const ws = new Workspace({}, { mode: MountMode.WRITE, ops })
    ws.addMount('/data/inner/deep', inner, MountMode.WRITE)
    ws.addMount('/other', outer, MountMode.WRITE)
    expect(await ws.fs.readdir('/data/inner')).toEqual(['/data/inner/deep'])
    expect((await ws.fs.stat('/data/inner')).type).toBe(FileType.DIRECTORY)
  })

  it('does not attribute a namespace answer to the lexical owner', async () => {
    // '/m/inner' is served by no backend: the parent mount is
    // ungranted for this session and the answer exists only because a
    // granted mount sits below it. Attributing it to the lexical owner
    // invents a network op against that backend for every such lookup.
    // Mirrors Python's tests/ops/test_ops.py.
    const outer = new RAMResource()
    const inner = new RAMResource()
    const ops = new OpsRegistry()
    for (const op of outer.ops()) ops.register({ ...op, resource: 's3' })
    ops.registerResource(inner)
    Object.assign(outer, { kind: 's3' })
    const ws = new Workspace({}, { mode: MountMode.WRITE, ops })
    ws.addMount('/m', outer, MountMode.WRITE)
    ws.addMount('/m/inner/deep', inner, MountMode.WRITE)
    const session = ws.createSession('agent', { mounts: { '/m/inner/deep': MountMode.EXEC } })
    await runWithSession(session, async () => {
      ws.records.length = 0
      expect(await ws.fs.readdir('/m/inner')).toEqual(['/m/inner/deep'])
      expect(ws.records.map((r) => [r.source, r.isCache])).toEqual([['ram', true]])
      expect(ws.networkRecords).toEqual([])
    })
  })

  it('does not attribute a denied namespace answer to the lexical owner', async () => {
    // Refusing the synthetic answer does not make the parent backend
    // have served it: a deny suppresses a result nothing was contacted
    // to produce. Mirrors Python's tests/ops/test_ops.py.
    const outer = new RAMResource()
    const inner = new RAMResource()
    const ops = new OpsRegistry()
    for (const op of outer.ops()) ops.register({ ...op, resource: 's3' })
    ops.registerResource(inner)
    Object.assign(outer, { kind: 's3' })
    const ws = new Workspace({}, { mode: MountMode.WRITE, ops, policies: [new DenyInner()] })
    ws.addMount('/m', outer, MountMode.WRITE)
    ws.addMount('/m/inner/deep', inner, MountMode.WRITE)
    const session = ws.createSession('agent', { mounts: { '/m/inner/deep': MountMode.EXEC } })
    await runWithSession(session, async () => {
      ws.records.length = 0
      await expect(ws.fs.readdir('/m/inner')).rejects.toThrow(PolicyDenied)
      expect(ws.records.map((r) => [r.source, r.isCache])).toEqual([['ram', true]])
      expect(ws.networkRecords).toEqual([])
    })
  })

  it('renders a registered filetype, and raw asks for the stored bytes', async () => {
    // The door stamps the path's extension so a filetype-scoped op wins;
    // `raw` passes an explicit null filetype to stop that, which is the
    // read the FUSE read-modify-write path needs.
    const resource = new RAMResource()
    const ops = new OpsRegistry()
    ops.registerResource(resource)
    ops.register({
      name: 'read',
      resource: resource.kind,
      filetype: '.gdoc.json',
      write: false,
      fn: () => Promise.resolve(new TextEncoder().encode('rendered')),
    })
    const ws = new Workspace({ '/m': resource }, { mode: MountMode.WRITE, ops })
    await ws.fs.writeFile('/m/doc.gdoc.json', 'stored')
    expect(await ws.fs.readFileText('/m/doc.gdoc.json')).toBe('rendered')
    expect(DEC.decode(await ws.fs.readFile('/m/doc.gdoc.json', { raw: true }))).toBe('stored')
  })

  it('does not serve a raw read from the file cache', async () => {
    // A rendering command's read lands in the file cache keyed on the
    // path alone (that is what `applyIo` does with an IOResult), so the
    // rendering sits under the very key a raw read asks for. Seeding
    // the cache directly is the same state one command earlier reaches.
    // Mirrors Python's tests/ops/test_raw_read.py.
    const resource = new RAMResource()
    Object.assign(resource, { cachesReads: true })
    const ops = new OpsRegistry()
    ops.registerResource(resource)
    const ws = new Workspace({ '/m': resource }, { mode: MountMode.WRITE, ops })
    await ws.fs.writeFile('/m/doc.gdoc.json', 'stored')
    await ws.cache.set('/m/doc.gdoc.json', new TextEncoder().encode('rendered'))
    expect(await ws.fs.readFileText('/m/doc.gdoc.json')).toBe('rendered')
    expect(DEC.decode(await ws.fs.readFile('/m/doc.gdoc.json', { raw: true }))).toBe('stored')
  })

  it('refuses a write to a read-only mount at the door', async () => {
    const resource = new RAMResource()
    const ops = new OpsRegistry()
    for (const op of resource.ops()) ops.register(op)
    const ws = new Workspace({ '/ro': resource }, { mode: MountMode.READ, ops })
    await expect(ws.fs.writeFile('/ro/a.txt', 'x')).rejects.toThrow('read-only')
  })
})

describe('Ops accounting survives the delegation', () => {
  class DenyBigReads implements Policy {
    postOps(ctx: OpsResultContext): Action | null {
      if (ctx.op === 'read') return { kind: 'deny', message: 'too big\n' }
      return null
    }
  }

  class CapReadsTo3 implements Policy {
    postOps(ctx: OpsResultContext): Action | null {
      if (ctx.op === 'read') return new Limit({ maxBytes: 3 })
      return null
    }
  }

  class HardCapReadsTo3 implements Policy {
    postOps(ctx: OpsResultContext): Action | null {
      if (ctx.op === 'read') return new Limit({ maxBytes: 3, onExceed: OnExceed.ERROR })
      return null
    }
  }

  class SealReads implements Policy {
    preOps(ctx: OpsContext): Action | null {
      if (ctx.op === 'read') return { kind: 'deny', message: 'sealed\n' }
      return null
    }
  }

  class BrokenPostOps implements Policy {
    postOps(ctx: OpsResultContext): Action | null {
      if (ctx.write && ctx.path.virtual === '/m/a.txt') return 42 as unknown as Action
      return null
    }
  }

  function mkWs(policy: Policy): Workspace {
    const resource = new RAMResource()
    const ops = new OpsRegistry()
    for (const op of resource.ops()) ops.register(op)
    return new Workspace({ '/data': resource }, { mode: MountMode.WRITE, ops, policies: [policy] })
  }

  it('records a post-denied read: the backend already ran', async () => {
    const ws = mkWs(new DenyBigReads())
    await ws.fs.writeFile('/data/a.txt', 'hello')
    await expect(ws.fs.readFile('/data/a.txt')).rejects.toThrow(PolicyDenied)
    expect(ws.records.map((r) => r.op)).toEqual(['write', 'read'])
  })

  it('records a capped read against what the backend moved', async () => {
    // A postOps Limit truncates what the caller receives; the transfer
    // already happened, so recording the capped length would
    // under-report networkBytes by whatever the cap removed.
    const ws = mkWs(new CapReadsTo3())
    await ws.fs.writeFile('/data/a.txt', '0123456789')
    expect(DEC.decode(await ws.fs.readFile('/data/a.txt'))).toBe('012')
    expect(ws.records.find((r) => r.op === 'read')?.bytes).toBe(10)
  })

  it('records a hard-capped read: the backend still moved the bytes', async () => {
    // An ERROR-mode cap refuses the caller the bytes, but the backend
    // already moved them; dropping the record loses the whole transfer
    // rather than just truncating it. Mirrors Python's test_policies.py.
    const resource = new RAMResource()
    Object.assign(resource, { kind: 's3' })
    const ops = new OpsRegistry()
    for (const op of resource.ops()) ops.register({ ...op, resource: 's3' })
    const ws = new Workspace(
      { '/m': resource },
      { mode: MountMode.WRITE, ops, policies: [new HardCapReadsTo3()] },
    )
    await ws.fs.writeFile('/m/a.txt', '0123456789')
    ws.records.length = 0
    await expect(ws.fs.readFile('/m/a.txt')).rejects.toThrow(LimitExceededError)
    const read = ws.records.find((r) => r.op === 'read')
    expect([read?.source, read?.bytes]).toEqual(['s3', 10])
    expect(ws.networkBytes).toBe(10)
  })

  it('records a committed write when bookkeeping after it fails', async () => {
    // The backend applied the write, then a step after it (here an
    // invalid postOps return, but any foreign bookkeeping error looks
    // the same) blew up. The error must propagate AND the transfer
    // must stay on the books: the door stamped the report at
    // completion, so the record does not depend on what kind of
    // exception followed. Mirrors Python's test_policies.py.
    const resource = new RAMResource()
    Object.assign(resource, { kind: 's3' })
    const ops = new OpsRegistry()
    for (const op of resource.ops()) ops.register({ ...op, resource: 's3' })
    const ws = new Workspace(
      { '/m': resource },
      { mode: MountMode.WRITE, ops, policies: [new BrokenPostOps()] },
    )
    ws.records.length = 0
    await expect(ws.fs.writeFile('/m/a.txt', '123456')).rejects.toThrow(PolicyError)
    expect(DEC.decode(await ws.fs.readFile('/m/a.txt'))).toBe('123456')
    const write = ws.records.find((r) => r.op === 'write')
    expect([write?.source, write?.bytes]).toEqual(['s3', 6])
    expect(ws.networkBytes).toBeGreaterThanOrEqual(6)
  })

  it('does not count a hard-capped warm read as network traffic', async () => {
    // Same refusal, but the cache produced the bytes, so the transfer
    // it stands for never happened.
    const resource = new RAMResource()
    Object.assign(resource, { cachesReads: true, kind: 's3' })
    const ops = new OpsRegistry()
    ops.registerResource(resource)
    const ws = new Workspace(
      { '/m': resource },
      { mode: MountMode.WRITE, ops, policies: [new HardCapReadsTo3()] },
    )
    await ws.cache.set('/m/a.txt', new TextEncoder().encode('0123456789'))
    ws.records.length = 0
    await expect(ws.fs.readFile('/m/a.txt')).rejects.toThrow(LimitExceededError)
    const read = ws.records.find((r) => r.op === 'read')
    expect(read?.source).toBe('ram')
    expect(read?.isCache).toBe(true)
    expect(ws.networkBytes).toBe(0)
  })

  it('does not count a denied warm read as network traffic', async () => {
    // The deny suppresses a result the cache produced, so nothing
    // crossed the network; recording it against the backend would count
    // traffic that never happened.
    const resource = new RAMResource()
    Object.assign(resource, { cachesReads: true, kind: 's3' })
    const ops = new OpsRegistry()
    ops.registerResource(resource)
    const ws = new Workspace(
      { '/m': resource },
      { mode: MountMode.WRITE, ops, policies: [new DenyBigReads()] },
    )
    await ws.cache.set('/m/a.txt', new TextEncoder().encode('0123456789'))
    ws.records.length = 0
    await expect(ws.fs.readFile('/m/a.txt')).rejects.toThrow(PolicyDenied)
    const read = ws.records.find((r) => r.op === 'read')
    expect(read?.source).toBe('ram')
    expect(read?.isCache).toBe(true)
    expect(ws.networkBytes).toBe(0)
  })

  it('records the bytes a post-denied read moved', async () => {
    // The suppressed result is the only place a read's byte count
    // lived, so without carrying it on the exception the record says
    // zero and networkBytes under-reports traffic that happened.
    const ws = mkWs(new DenyBigReads())
    await ws.fs.writeFile('/data/a.txt', 'hello')
    await expect(ws.fs.readFile('/data/a.txt')).rejects.toThrow(PolicyDenied)
    const read = ws.records.find((r) => r.op === 'read')
    expect(read?.bytes).toBe(5)
  })

  it('records nothing for a pre-denied read: the backend never ran', async () => {
    const ws = mkWs(new SealReads())
    await ws.fs.writeFile('/data/a.txt', 'hello')
    await expect(ws.fs.readFile('/data/a.txt')).rejects.toThrow(PolicyDenied)
    expect(ws.records.map((r) => r.op)).toEqual(['write'])
  })
})

describe('a warm cache still answers a ranged read with the window', () => {
  // The cache holds the whole object; a ranged read asked for a window
  // instead of the file, so serving the file back is wrong. git reads
  // pack indexes this way (4 bytes at a known offset) and reaches the
  // dispatcher directly, which is where the window has to be applied.
  // Mirrors Python's tests/ops/test_raw_read.py.
  function mkCaching(): Workspace {
    const resource = new RAMResource()
    Object.assign(resource, { cachesReads: true })
    const ops = new OpsRegistry()
    ops.registerResource(resource)
    return new Workspace({ '/m': resource }, { mode: MountMode.WRITE, ops })
  }

  async function readAt(ws: Workspace, offset: number, size: number | null): Promise<string> {
    const kwargs = size === null ? { offset } : { offset, size }
    const body = await ws.dispatch('read', '/m/f.bin', [], kwargs)
    return DEC.decode(body as Uint8Array)
  }

  it('slices the cached bytes instead of returning the whole file', async () => {
    const ws = mkCaching()
    await ws.fs.writeFile('/m/f.bin', '0123456789')
    const cold = await readAt(ws, 2, 3)
    await ws.cache.set('/m/f.bin', new TextEncoder().encode('0123456789'))
    expect(await readAt(ws, 2, 3)).toBe(cold)
    expect(await readAt(ws, 2, 3)).toBe('234')
    expect(await readAt(ws, 7, null)).toBe('789')
    expect(await readAt(ws, 2, 0)).toBe('')
    expect(await readAt(ws, 99, 3)).toBe('')
  })

  it('still serves the whole file when no window was asked for', async () => {
    const ws = mkCaching()
    await ws.fs.writeFile('/m/f.bin', '0123456789')
    await ws.cache.set('/m/f.bin', new TextEncoder().encode('CACHED-VAL'))
    expect(await ws.fs.readFileText('/m/f.bin')).toBe('CACHED-VAL')
  })
})

describe('Ops rename is bounded by the mount', () => {
  function mkTwoMounts(): Workspace {
    const a = new RAMResource()
    const b = new RAMResource()
    const ops = new OpsRegistry()
    ops.registerResource(a)
    ops.registerResource(b)
    const ws = new Workspace({}, { mode: MountMode.WRITE, ops })
    ws.addMount('/a', a, MountMode.WRITE)
    ws.addMount('/b', b, MountMode.WRITE)
    return ws
  }

  it('renames within one mount', async () => {
    const ws = mkTwoMounts()
    await ws.fs.writeFile('/a/x.txt', 'bytes')
    await ws.fs.rename('/a/x.txt', '/a/y.txt')
    expect(await ws.fs.readFileText('/a/y.txt')).toBe('bytes')
    expect(await ws.fs.exists('/a/x.txt')).toBe(false)
  })

  it('refuses a cross-mount rename with EXDEV, leaving the source intact', async () => {
    // EXDEV is what tells a caller (the kernel behind a FUSE mount, and
    // mv behind that) to fall back to copy+unlink instead of addressing
    // the destination against the source's backend.
    const ws = mkTwoMounts()
    await ws.fs.writeFile('/a/x.txt', 'bytes')
    await expect(ws.fs.rename('/a/x.txt', '/b/y.txt')).rejects.toMatchObject({ code: 'EXDEV' })
    expect(await ws.fs.readFileText('/a/x.txt')).toBe('bytes')
    expect(await ws.fs.exists('/b/y.txt')).toBe(false)
  })

  it('refuses a rename to a path no mount serves', async () => {
    const ws = mkTwoMounts()
    await ws.fs.writeFile('/a/x.txt', 'bytes')
    await expect(ws.fs.rename('/a/x.txt', '/nowhere/y.txt')).rejects.toMatchObject({
      code: 'EXDEV',
    })
    expect(await ws.fs.readFileText('/a/x.txt')).toBe('bytes')
  })
})
