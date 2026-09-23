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
import { LimitExceededError } from '../commands/errors.ts'
import { OpsRegistry } from './registry.ts'
import type { Policy } from '../policy/base.ts'
import { PolicyDenied, PolicyError } from '../policy/errors.ts'
import type { Action, OpsContext, OpsResultContext } from '../policy/types.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { FileType, Limit, MountMode, OnExceed } from '../types.ts'
import { enoent, enotdir } from '../utils/errors.ts'
import { Session } from '../workspace/workspace/handle.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'

const DEC = new TextDecoder()

function mkWorkspace(): Workspace {
  const vfs = new RAMVFS()
  const ops = new OpsRegistry()
  for (const op of vfs.ops()) ops.register(op)
  return new Workspace({ '/data': vfs }, { mode: MountMode.WRITE, ops })
}

// The Workspace constructor re-registers each mount's ops, so the failing
// stat has to land on the registry after the workspace is built.
function mkFailingStat(err: unknown): Workspace {
  const vfs = new RAMVFS()
  const ops = new OpsRegistry()
  for (const op of vfs.ops()) ops.register(op)
  const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE, ops })
  ops.register({
    name: 'stat',
    vfs: vfs.kind,
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
    await ws.vfs.writeFile('/data/a.txt', 'hello')
    const text = await ws.vfs.readFileText('/data/a.txt')
    expect(text).toBe('hello')
  })

  it('writeFile accepts Uint8Array', async () => {
    const ws = mkWorkspace()
    await ws.vfs.writeFile('/data/b.bin', new Uint8Array([1, 2, 3]))
    const bytes = await ws.vfs.readFile('/data/b.bin')
    expect([...bytes]).toEqual([1, 2, 3])
  })

  it('readFile takes a window the way the python facade does', async () => {
    const ws = mkWorkspace()
    await ws.vfs.writeFile('/data/r.txt', '0123456789')
    expect(DEC.decode(await ws.vfs.readFile('/data/r.txt', { offset: 2, size: 3 }))).toBe('234')
    expect(DEC.decode(await ws.vfs.readFile('/data/r.txt', { offset: 7 }))).toBe('789')
    expect(DEC.decode(await ws.vfs.readFile('/data/r.txt', { size: 4 }))).toBe('0123')
  })

  it('reads a window shorter than asked rather than failing past EOF', async () => {
    const ws = mkWorkspace()
    await ws.vfs.writeFile('/data/r.txt', 'abc')
    expect(DEC.decode(await ws.vfs.readFile('/data/r.txt', { size: 100 }))).toBe('abc')
    expect(await ws.vfs.readFile('/data/r.txt', { offset: 99, size: 5 })).toEqual(new Uint8Array(0))
    expect(await ws.vfs.readFile('/data/r.txt', { size: 0 })).toEqual(new Uint8Array(0))
  })

  it('mkdir + readdir lists entries', async () => {
    const ws = mkWorkspace()
    await ws.vfs.mkdir('/data/sub')
    await ws.vfs.writeFile('/data/sub/x.txt', 'x')
    await ws.vfs.writeFile('/data/sub/y.txt', 'y')
    const entries = await ws.vfs.readdir('/data/sub')
    expect(entries.sort()).toEqual(['/data/sub/x.txt', '/data/sub/y.txt'])
  })

  it('append extends a file through the append op (the python facade has it too)', async () => {
    const ws = mkWorkspace()
    await ws.vfs.writeFile('/data/log.txt', 'head')
    await ws.vfs.append('/data/log.txt', new TextEncoder().encode('-tail'))
    expect(await ws.vfs.readFileText('/data/log.txt')).toBe('head-tail')
    expect(ws.records.map((r) => r.op)).toContain('append')
  })

  it('exists returns true for existing files and dirs', async () => {
    const ws = mkWorkspace()
    await ws.vfs.writeFile('/data/hi.txt', 'hi')
    await ws.vfs.mkdir('/data/dir')
    expect(await ws.vfs.exists('/data/hi.txt')).toBe(true)
    expect(await ws.vfs.exists('/data/dir')).toBe(true)
    expect(await ws.vfs.exists('/data/nope')).toBe(false)
  })

  it('isDir distinguishes files from directories', async () => {
    const ws = mkWorkspace()
    await ws.vfs.writeFile('/data/file.txt', 'x')
    await ws.vfs.mkdir('/data/dir')
    expect(await ws.vfs.isDir('/data/dir')).toBe(true)
    expect(await ws.vfs.isDir('/data/file.txt')).toBe(false)
    expect(await ws.vfs.isFile('/data/file.txt')).toBe(true)
    expect(await ws.vfs.isFile('/data/dir')).toBe(false)
  })

  it('stat returns size', async () => {
    const ws = mkWorkspace()
    await ws.vfs.writeFile('/data/a.txt', 'hello')
    const s = await ws.vfs.stat('/data/a.txt')
    expect(s.size).toBe(5)
  })

  it('unlink removes file', async () => {
    const ws = mkWorkspace()
    await ws.vfs.writeFile('/data/gone.txt', 'x')
    expect(await ws.vfs.exists('/data/gone.txt')).toBe(true)
    await ws.vfs.unlink('/data/gone.txt')
    expect(await ws.vfs.exists('/data/gone.txt')).toBe(false)
  })

  it('cat reads file as string', async () => {
    const ws = mkWorkspace()
    await ws.vfs.writeFile('/data/t.txt', 'content')
    expect(await ws.vfs.cat('/data/t.txt')).toBe('content')
  })
})

describe('Ops existence probes', () => {
  it('report false for a missing path', async () => {
    const ws = mkWorkspace()
    expect(await ws.vfs.exists('/data/nope')).toBe(false)
    expect(await ws.vfs.isDir('/data/nope')).toBe(false)
    expect(await ws.vfs.isFile('/data/nope')).toBe(false)
  })

  it('report false for a path outside every mount', async () => {
    const ws = mkWorkspace()
    expect(await ws.vfs.exists('/nowhere/x')).toBe(false)
    expect(await ws.vfs.isDir('/nowhere/x')).toBe(false)
    expect(await ws.vfs.isFile('/nowhere/x')).toBe(false)
  })

  it('propagate a backend failure instead of reporting it as missing', async () => {
    const ws = mkFailingStat(new Error('401 Unauthorized'))
    await expect(ws.vfs.exists('/data/a.txt')).rejects.toThrow('401 Unauthorized')
    await expect(ws.vfs.isDir('/data/a.txt')).rejects.toThrow('401 Unauthorized')
    await expect(ws.vfs.isFile('/data/a.txt')).rejects.toThrow('401 Unauthorized')
  })

  it('propagate a non-ENOENT fs error, matching Python which swallows only two', async () => {
    const ws = mkFailingStat(enotdir('/data/a.txt'))
    await expect(ws.vfs.exists('/data/a.txt')).rejects.toThrow('/data/a.txt')
    await expect(ws.vfs.isDir('/data/a.txt')).rejects.toThrow('/data/a.txt')
    await expect(ws.vfs.isFile('/data/a.txt')).rejects.toThrow('/data/a.txt')
  })
})

// The op facade is an op door like the dispatcher: FUSE and programmatic
// access read through it, so policy hooks must fire here too.
describe('Ops policy door', () => {
  class SealReads implements Policy {
    preOps(ctx: OpsContext): Action | null {
      if (!ctx.write && ctx.path.virtual.endsWith('.sealed')) {
        return { kind: 'deny', reason: 'sealed' }
      }
      return null
    }
  }

  class RedactReads implements Policy {
    postOps(ctx: OpsResultContext): Action | null {
      const data = ctx.result instanceof Uint8Array ? ctx.result : null
      if (ctx.op === 'read' && data !== null && DEC.decode(data).includes('TOPSECRET')) {
        return { kind: 'deny', reason: 'redacted' }
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
        return { kind: 'deny', reason: 'locked' }
      }
      return null
    }
  }

  function mkGuarded(): Workspace {
    const vfs = new RAMVFS()
    const ops = new OpsRegistry()
    for (const op of vfs.ops()) ops.register(op)
    return new Workspace(
      { '/data': vfs },
      {
        mode: MountMode.WRITE,
        ops,
        policies: [new SealReads(), new RedactReads(), new CapReads(), new LockWrites()],
      },
    )
  }

  it('preOps denies a read through the facade with EACCES', async () => {
    const ws = mkGuarded()
    await ws.vfs.writeFile('/data/x.sealed', 'nope\n')
    await expect(ws.vfs.readFile('/data/x.sealed')).rejects.toThrow(PolicyDenied)
  })

  it('postOps denies on result content the pre hook cannot see', async () => {
    const ws = mkGuarded()
    await ws.vfs.writeFile('/data/secret.txt', 'TOPSECRET plans\n')
    await expect(ws.vfs.readFile('/data/secret.txt')).rejects.toThrow(PolicyDenied)
    await ws.vfs.writeFile('/data/clean.txt', 'hello\n')
    expect(await ws.vfs.readFileText('/data/clean.txt')).toBe('hello\n')
  })

  it('postOps Limit caps facade read bytes', async () => {
    const ws = mkGuarded()
    await ws.vfs.writeFile('/data/big.log', 'abcdefghij\n')
    expect(DEC.decode(await ws.vfs.readFile('/data/big.log'))).toBe('abcde')
  })

  it('preOps denies a facade write before the backend runs', async () => {
    const ws = mkGuarded()
    await expect(ws.vfs.writeFile('/data/locked/f.txt', 'hi')).rejects.toThrow(PolicyDenied)
    expect(await ws.vfs.exists('/data/locked/f.txt')).toBe(false)
  })

  it('classifies setxattr and removexattr as writes', async () => {
    const ws = mkGuarded()
    const value = new TextEncoder().encode('v')
    await expect(ws.vfs.setxattr('/data/locked/f.txt', 'user.a', value)).rejects.toThrow(
      PolicyDenied,
    )
    await expect(ws.vfs.removexattr('/data/locked/f.txt', 'user.a')).rejects.toThrow(PolicyDenied)
  })
})

// The facade is not a second pipeline: it hands every op to the
// dispatcher, so what the shell sees and what ws.vfs sees cannot drift,
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
    const vfs = new RAMVFS()
    const ops = new OpsRegistry()
    for (const op of vfs.ops()) ops.register(op)
    const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE, ops, policies: [counter] })
    await ws.vfs.writeFile('/data/a.txt', 'hello')
    await ws.vfs.readFile('/data/a.txt')
    expect(counter.seen).toEqual(['write:/data/', 'read:/data/'])
  })

  class DenyInner implements Policy {
    postOps(ctx: OpsResultContext): Action | null {
      if (ctx.path.virtual === '/m/inner') return { kind: 'deny', reason: 'no' }
      return null
    }
  }

  it('serves the namespace structure a nested mount implies', async () => {
    // '/data/inner' is served by no backend: it exists only because a
    // mount sits below it. The dispatcher answers it, so the facade
    // does too.
    const outer = new RAMVFS()
    const inner = new RAMVFS()
    const ops = new OpsRegistry()
    ops.registerVfs(outer)
    ops.registerVfs(inner)
    const ws = new Workspace({}, { mode: MountMode.WRITE, ops })
    ws.addMount('/data/inner/deep', inner, MountMode.WRITE)
    ws.addMount('/other', outer, MountMode.WRITE)
    expect(await ws.vfs.readdir('/data/inner')).toEqual(['/data/inner/deep'])
    expect((await ws.vfs.stat('/data/inner')).type).toBe(FileType.DIRECTORY)
  })

  it('does not attribute a namespace answer to the lexical owner', async () => {
    // '/m/inner' is served by no backend: the parent mount is
    // ungranted for this session and the answer exists only because a
    // granted mount sits below it. Attributing it to the lexical owner
    // invents a network op against that backend for every such lookup.
    // Mirrors Python's tests/ops/test_ops.py.
    const outer = new RAMVFS()
    const inner = new RAMVFS()
    const ops = new OpsRegistry()
    for (const op of outer.ops()) ops.register({ ...op, vfs: 's3' })
    ops.registerVfs(inner)
    Object.assign(outer, { kind: 's3' })
    const ws = new Workspace({}, { mode: MountMode.WRITE, ops })
    ws.addMount('/m', outer, MountMode.WRITE)
    ws.addMount('/m/inner/deep', inner, MountMode.WRITE)
    const session = ws.createSession('agent', { mounts: { '/m/inner/deep': MountMode.EXEC } })
    await runWithSession(session, async () => {
      ws.records.length = 0
      expect(await ws.vfs.readdir('/m/inner')).toEqual(['/m/inner/deep'])
      expect(ws.records.map((r) => [r.source, r.isCache])).toEqual([['ram', true]])
      expect(ws.networkRecords).toEqual([])
    })
  })

  it('does not attribute a denied namespace answer to the lexical owner', async () => {
    // Refusing the synthetic answer does not make the parent backend
    // have served it: a deny suppresses a result nothing was contacted
    // to produce. Mirrors Python's tests/ops/test_ops.py.
    const outer = new RAMVFS()
    const inner = new RAMVFS()
    const ops = new OpsRegistry()
    for (const op of outer.ops()) ops.register({ ...op, vfs: 's3' })
    ops.registerVfs(inner)
    Object.assign(outer, { kind: 's3' })
    const ws = new Workspace({}, { mode: MountMode.WRITE, ops, policies: [new DenyInner()] })
    ws.addMount('/m', outer, MountMode.WRITE)
    ws.addMount('/m/inner/deep', inner, MountMode.WRITE)
    const session = ws.createSession('agent', { mounts: { '/m/inner/deep': MountMode.EXEC } })
    await runWithSession(session, async () => {
      ws.records.length = 0
      await expect(ws.vfs.readdir('/m/inner')).rejects.toThrow(PolicyDenied)
      expect(ws.records.map((r) => [r.source, r.isCache])).toEqual([['ram', true]])
      expect(ws.networkRecords).toEqual([])
    })
  })

  it('renders a registered filetype, and raw asks for the stored bytes', async () => {
    // The door stamps the path's extension so a filetype-scoped op wins;
    // `raw` passes an explicit null filetype to stop that, which is the
    // read the FUSE read-modify-write path needs.
    const vfs = new RAMVFS()
    const ops = new OpsRegistry()
    ops.registerVfs(vfs)
    ops.register({
      name: 'read',
      vfs: vfs.kind,
      filetype: '.gdoc.json',
      write: false,
      fn: () => Promise.resolve(new TextEncoder().encode('rendered')),
    })
    const ws = new Workspace({ '/m': vfs }, { mode: MountMode.WRITE, ops })
    await ws.vfs.writeFile('/m/doc.gdoc.json', 'stored')
    expect(await ws.vfs.readFileText('/m/doc.gdoc.json')).toBe('rendered')
    expect(DEC.decode(await ws.vfs.readFile('/m/doc.gdoc.json', { raw: true }))).toBe('stored')
  })

  it('does not serve a raw read from the file cache', async () => {
    // A rendering command's read lands in the file cache keyed on the
    // path alone (that is what `applyIo` does with an IOResult), so the
    // rendering sits under the very key a raw read asks for. Seeding
    // the cache directly is the same state one command earlier reaches.
    // Mirrors Python's tests/ops/test_raw_read.py.
    const vfs = new RAMVFS()
    Object.assign(vfs, { cachesReads: true })
    const ops = new OpsRegistry()
    ops.registerVfs(vfs)
    const ws = new Workspace({ '/m': vfs }, { mode: MountMode.WRITE, ops })
    await ws.vfs.writeFile('/m/doc.gdoc.json', 'stored')
    await ws.cache.set('/m/doc.gdoc.json', new TextEncoder().encode('rendered'), { ttl: 600 })
    expect(await ws.vfs.readFileText('/m/doc.gdoc.json')).toBe('rendered')
    expect(DEC.decode(await ws.vfs.readFile('/m/doc.gdoc.json', { raw: true }))).toBe('stored')
  })

  it('refuses a write to a read-only mount at the door', async () => {
    const vfs = new RAMVFS()
    const ops = new OpsRegistry()
    for (const op of vfs.ops()) ops.register(op)
    const ws = new Workspace({ '/ro': vfs }, { mode: MountMode.READ, ops })
    await expect(ws.vfs.writeFile('/ro/a.txt', 'x')).rejects.toThrow('read-only')
  })
})

describe('Ops accounting survives the delegation', () => {
  class DenyBigReads implements Policy {
    postOps(ctx: OpsResultContext): Action | null {
      if (ctx.op === 'read') return { kind: 'deny', reason: 'too big' }
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
      if (ctx.op === 'read') return { kind: 'deny', reason: 'sealed' }
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
    const vfs = new RAMVFS()
    const ops = new OpsRegistry()
    for (const op of vfs.ops()) ops.register(op)
    return new Workspace({ '/data': vfs }, { mode: MountMode.WRITE, ops, policies: [policy] })
  }

  it('records a post-denied read: the backend already ran', async () => {
    const ws = mkWs(new DenyBigReads())
    await ws.vfs.writeFile('/data/a.txt', 'hello')
    await expect(ws.vfs.readFile('/data/a.txt')).rejects.toThrow(PolicyDenied)
    expect(ws.records.map((r) => r.op)).toEqual(['write', 'read'])
  })

  it('records a capped read against what the backend moved', async () => {
    // A postOps Limit truncates what the caller receives; the transfer
    // already happened, so recording the capped length would
    // under-report networkBytes by whatever the cap removed.
    const ws = mkWs(new CapReadsTo3())
    await ws.vfs.writeFile('/data/a.txt', '0123456789')
    expect(DEC.decode(await ws.vfs.readFile('/data/a.txt'))).toBe('012')
    expect(ws.records.find((r) => r.op === 'read')?.bytes).toBe(10)
  })

  it('records a hard-capped read: the backend still moved the bytes', async () => {
    // An ERROR-mode cap refuses the caller the bytes, but the backend
    // already moved them; dropping the record loses the whole transfer
    // rather than just truncating it. Mirrors Python's test_policies.py.
    const vfs = new RAMVFS()
    Object.assign(vfs, { kind: 's3' })
    const ops = new OpsRegistry()
    for (const op of vfs.ops()) ops.register({ ...op, vfs: 's3' })
    const ws = new Workspace(
      { '/m': vfs },
      { mode: MountMode.WRITE, ops, policies: [new HardCapReadsTo3()] },
    )
    await ws.vfs.writeFile('/m/a.txt', '0123456789')
    ws.records.length = 0
    await expect(ws.vfs.readFile('/m/a.txt')).rejects.toThrow(LimitExceededError)
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
    const vfs = new RAMVFS()
    Object.assign(vfs, { kind: 's3' })
    const ops = new OpsRegistry()
    for (const op of vfs.ops()) ops.register({ ...op, vfs: 's3' })
    const ws = new Workspace(
      { '/m': vfs },
      { mode: MountMode.WRITE, ops, policies: [new BrokenPostOps()] },
    )
    ws.records.length = 0
    await expect(ws.vfs.writeFile('/m/a.txt', '123456')).rejects.toThrow(PolicyError)
    expect(DEC.decode(await ws.vfs.readFile('/m/a.txt'))).toBe('123456')
    const write = ws.records.find((r) => r.op === 'write')
    expect([write?.source, write?.bytes]).toEqual(['s3', 6])
    expect(ws.networkBytes).toBeGreaterThanOrEqual(6)
  })

  it('does not count a hard-capped warm read as network traffic', async () => {
    // Same refusal, but the cache produced the bytes, so the transfer
    // it stands for never happened.
    const vfs = new RAMVFS()
    Object.assign(vfs, { cachesReads: true, kind: 's3' })
    const ops = new OpsRegistry()
    ops.registerVfs(vfs)
    const ws = new Workspace(
      { '/m': vfs },
      { mode: MountMode.WRITE, ops, policies: [new HardCapReadsTo3()] },
    )
    await ws.cache.set('/m/a.txt', new TextEncoder().encode('0123456789'), { ttl: 600 })
    ws.records.length = 0
    await expect(ws.vfs.readFile('/m/a.txt')).rejects.toThrow(LimitExceededError)
    const read = ws.records.find((r) => r.op === 'read')
    expect(read?.source).toBe('ram')
    expect(read?.isCache).toBe(true)
    expect(ws.networkBytes).toBe(0)
  })

  it('does not count a denied warm read as network traffic', async () => {
    // The deny suppresses a result the cache produced, so nothing
    // crossed the network; recording it against the backend would count
    // traffic that never happened.
    const vfs = new RAMVFS()
    Object.assign(vfs, { cachesReads: true, kind: 's3' })
    const ops = new OpsRegistry()
    ops.registerVfs(vfs)
    const ws = new Workspace(
      { '/m': vfs },
      { mode: MountMode.WRITE, ops, policies: [new DenyBigReads()] },
    )
    await ws.cache.set('/m/a.txt', new TextEncoder().encode('0123456789'), { ttl: 600 })
    ws.records.length = 0
    await expect(ws.vfs.readFile('/m/a.txt')).rejects.toThrow(PolicyDenied)
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
    await ws.vfs.writeFile('/data/a.txt', 'hello')
    await expect(ws.vfs.readFile('/data/a.txt')).rejects.toThrow(PolicyDenied)
    const read = ws.records.find((r) => r.op === 'read')
    expect(read?.bytes).toBe(5)
  })

  it('records nothing for a pre-denied read: the backend never ran', async () => {
    const ws = mkWs(new SealReads())
    await ws.vfs.writeFile('/data/a.txt', 'hello')
    await expect(ws.vfs.readFile('/data/a.txt')).rejects.toThrow(PolicyDenied)
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
    const vfs = new RAMVFS()
    Object.assign(vfs, { cachesReads: true })
    const ops = new OpsRegistry()
    ops.registerVfs(vfs)
    return new Workspace({ '/m': vfs }, { mode: MountMode.WRITE, ops })
  }

  async function readAt(ws: Workspace, offset: number, size: number | null): Promise<string> {
    const kwargs = size === null ? { offset } : { offset, size }
    const body = await ws.dispatch('read', '/m/f.bin', [], kwargs)
    return DEC.decode(body as Uint8Array)
  }

  it('slices the cached bytes instead of returning the whole file', async () => {
    const ws = mkCaching()
    await ws.vfs.writeFile('/m/f.bin', '0123456789')
    const cold = await readAt(ws, 2, 3)
    await ws.cache.set('/m/f.bin', new TextEncoder().encode('0123456789'), { ttl: 600 })
    expect(await readAt(ws, 2, 3)).toBe(cold)
    expect(await readAt(ws, 2, 3)).toBe('234')
    expect(await readAt(ws, 7, null)).toBe('789')
    expect(await readAt(ws, 2, 0)).toBe('')
    expect(await readAt(ws, 99, 3)).toBe('')
  })

  it('still serves the whole file when no window was asked for', async () => {
    const ws = mkCaching()
    await ws.vfs.writeFile('/m/f.bin', '0123456789')
    await ws.cache.set('/m/f.bin', new TextEncoder().encode('CACHED-VAL'), { ttl: 600 })
    expect(await ws.vfs.readFileText('/m/f.bin')).toBe('CACHED-VAL')
  })
})

describe('Ops rename is bounded by the mount', () => {
  function mkTwoMounts(): Workspace {
    const a = new RAMVFS()
    const b = new RAMVFS()
    const ops = new OpsRegistry()
    ops.registerVfs(a)
    ops.registerVfs(b)
    const ws = new Workspace({}, { mode: MountMode.WRITE, ops })
    ws.addMount('/a', a, MountMode.WRITE)
    ws.addMount('/b', b, MountMode.WRITE)
    return ws
  }

  it('renames within one mount', async () => {
    const ws = mkTwoMounts()
    await ws.vfs.writeFile('/a/x.txt', 'bytes')
    await ws.vfs.rename('/a/x.txt', '/a/y.txt')
    expect(await ws.vfs.readFileText('/a/y.txt')).toBe('bytes')
    expect(await ws.vfs.exists('/a/x.txt')).toBe(false)
  })

  it('refuses a cross-mount rename with EXDEV, leaving the source intact', async () => {
    // EXDEV is what tells a caller (the kernel behind a FUSE mount, and
    // mv behind that) to fall back to copy+unlink instead of addressing
    // the destination against the source's backend.
    const ws = mkTwoMounts()
    await ws.vfs.writeFile('/a/x.txt', 'bytes')
    await expect(ws.vfs.rename('/a/x.txt', '/b/y.txt')).rejects.toMatchObject({ code: 'EXDEV' })
    expect(await ws.vfs.readFileText('/a/x.txt')).toBe('bytes')
    expect(await ws.vfs.exists('/b/y.txt')).toBe(false)
  })

  it('refuses a rename to a path no mount serves', async () => {
    const ws = mkTwoMounts()
    await ws.vfs.writeFile('/a/x.txt', 'bytes')
    await expect(ws.vfs.rename('/a/x.txt', '/nowhere/y.txt')).rejects.toMatchObject({
      code: 'EXDEV',
    })
    expect(await ws.vfs.readFileText('/a/x.txt')).toBe('bytes')
  })
})

describe('Ops.setattr', () => {
  it('lands where stat reads it', async () => {
    const ws = mkWorkspace()
    await ws.vfs.mkdir('/data/dir')
    await ws.vfs.writeFile('/data/dir/f.txt', 'hello')
    await ws.vfs.setattr('/data/dir/f.txt', { mode: 0o600, uid: 4242 })
    const st = await ws.vfs.stat('/data/dir/f.txt')
    expect(st.mode).toBe(0o600)
    expect(st.uid).toBe(4242)
  })

  it('writes the link entry itself under nofollow', async () => {
    const ws = mkWorkspace()
    await ws.vfs.mkdir('/data/dir')
    await ws.vfs.writeFile('/data/dir/f.txt', 'hello')
    await ws.vfs.symlink('/data/dir/link', 'f.txt')
    // A link has no backend inode, so the door keeps its attrs and the
    // target is left alone.
    expect(await ws.vfs.setattr('/data/dir/link', { mode: 0o640, nofollow: true })).toEqual({
      mode: 0o640,
    })
    expect((await ws.vfs.stat('/data/dir/f.txt')).mode ?? null).toBeNull()
  })

  it('follows a link by default', async () => {
    const ws = mkWorkspace()
    await ws.vfs.mkdir('/data/dir')
    await ws.vfs.writeFile('/data/dir/f.txt', 'hello')
    await ws.vfs.symlink('/data/dir/link', 'f.txt')
    await ws.vfs.setattr('/data/dir/link', { uid: 9 })
    expect((await ws.vfs.stat('/data/dir/f.txt')).uid).toBe(9)
  })
})

// readlink(2) splits its two misses and callers read them differently:
// EINVAL means "there, but not a link", ENOENT means "not there". Pinned
// against real Linux (python:3.13-slim): a file, a directory and a mount
// root all answer EINVAL, and a missing path answers ENOENT whether or
// not its parent exists.
describe('Ops.readlink', () => {
  const codeOf = async (ws: Workspace, path: string): Promise<string> => {
    try {
      await ws.vfs.readlink(path)
      return 'ok'
    } catch (err) {
      return String((err as { code?: string }).code)
    }
  }

  it('answers the target for a link', async () => {
    const ws = mkWorkspace()
    await ws.vfs.writeFile('/data/f.txt', 'x')
    await ws.vfs.symlink('/data/l', 'f.txt')
    expect(await ws.vfs.readlink('/data/l')).toBe('f.txt')
  })

  it('answers EINVAL for a path that is there but is not a link', async () => {
    const ws = mkWorkspace()
    await ws.vfs.writeFile('/data/f.txt', 'x')
    await ws.vfs.mkdir('/data/d')
    expect(await codeOf(ws, '/data/f.txt')).toBe('EINVAL')
    expect(await codeOf(ws, '/data/d')).toBe('EINVAL')
    expect(await codeOf(ws, '/data')).toBe('EINVAL')
  })

  it('answers ENOENT for a path that is not there', async () => {
    const ws = mkWorkspace()
    await ws.vfs.mkdir('/data/d')
    expect(await codeOf(ws, '/data/missing')).toBe('ENOENT')
    expect(await codeOf(ws, '/data/d/deep/missing')).toBe('ENOENT')
  })

  // A store that keeps no directory object answers stat with a miss, so
  // absence takes the parent's listing too: reading only the first
  // channel would report an implicit directory as ENOENT.
  it('reads the listing channel when a backend has no directory object', async () => {
    const vfs = new RAMVFS()
    const ops = new OpsRegistry()
    const realReaddir = vfs.ops().find((op) => op.name === 'readdir')?.fn
    if (realReaddir === undefined) throw new Error('RAMVFS has no readdir op')
    for (const op of vfs.ops()) ops.register(op)
    const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE, ops })
    await ws.vfs.mkdir('/data/d')
    await ws.vfs.writeFile('/data/d/under.txt', 'x')
    // Registered after the writes, so only the probe sees them: a prefix
    // store answers stat with nothing for a directory, and a name with
    // no keys under it is in no listing either, which is how such a
    // store says a directory is not there. Two different answers with
    // stat silenced is what proves the listing is the channel read.
    ops.register({
      name: 'stat',
      vfs: vfs.kind,
      filetype: null,
      fn: () => {
        throw enoent('/data/d')
      },
      write: false,
    })
    ops.register({
      name: 'readdir',
      vfs: vfs.kind,
      filetype: null,
      fn: async (accessor, path, args, kwargs) => {
        const entries = (await realReaddir(accessor, path, args, kwargs)) as string[]
        return entries.filter((entry) => !entry.replace(/\/+$/, '').endsWith('hollow'))
      },
      write: false,
    })
    expect(await codeOf(ws, '/data/d')).toBe('EINVAL')
    await ws.vfs.mkdir('/data/hollow')
    expect(await codeOf(ws, '/data/hollow')).toBe('ENOENT')
  })

  // The probe reads on the caller's behalf, never past a refusal: a
  // channel that will not answer is not evidence of absence, so the
  // errno collapses to the EINVAL every miss gave before the split.
  it('does not probe past a policy that denies stat', async () => {
    const vfs = new RAMVFS()
    const ops = new OpsRegistry()
    for (const op of vfs.ops()) ops.register(op)
    const noProbe: Policy = {
      preOps: (ctx: OpsContext) =>
        Promise.resolve(
          ctx.op === 'stat' || ctx.op === 'readdir'
            ? { kind: 'deny' as const, reason: 'no probing' }
            : null,
        ),
    }
    const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE, ops, policies: [noProbe] })
    expect(await codeOf(ws, '/data/missing')).toBe('EINVAL')
  })
})

// `sessionId` on an op, and the one rule that bounds it. A shell line
// *sets* the session; an op *inherits* it. So the argument names the
// session to run as when no line is running, and the line's session
// wins when one is -- which is what keeps a handler reaching this door
// from widening the view it was given. Mirrors python's
// `TestPerCallSession`.
describe('Ops per-call sessionId', () => {
  async function splitWs(): Promise<Workspace> {
    const vfs = new RAMVFS()
    const ops = new OpsRegistry()
    for (const op of vfs.ops()) ops.register(op)
    const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE, ops })
    await ws.vfs.writeFile('/data/secret.txt', 'classified')
    await ws.vfs.writeFile('/data/open.txt', 'public')
    ws.createSession('blind', {
      permissions: { paths: { hide: ['/data/secret.txt'] } },
    })
    ws.createSession('seeing', { permissions: {} })
    return ws
  }

  it('runs the op as the session it names', async () => {
    const ws = await splitWs()
    expect(await ws.vfs.readFileText('/data/secret.txt', 'utf-8', 'seeing')).toBe('classified')
    expect(await ws.vfs.exists('/data/secret.txt', 'blind')).toBe(false)
    expect(await ws.vfs.readdir('/data', 'blind')).toEqual(['/data/open.txt'])
  })

  it('confines a write to the session it names', async () => {
    const ws = await splitWs()
    await expect(ws.vfs.writeFile('/data/secret.txt', 'x', 'blind')).rejects.toThrow()
  })

  it('carries the session through a forwarding method', async () => {
    // cat/listFiles/isFile answer through readFile/readdir/stat, so the
    // session has to survive the hop or a convenience method would
    // quietly read as the default.
    const ws = await splitWs()
    expect(await ws.vfs.cat('/data/secret.txt', 'seeing')).toBe('classified')
    expect(await ws.vfs.listFiles('/data', 'blind')).toEqual(['open.txt'])
    expect(await ws.vfs.isFile('/data/secret.txt', 'blind')).toBe(false)
  })

  it('lets a line in progress outrank the named session', async () => {
    // The door never widens a caller's view: a command running for a
    // confined session cannot read as a wider one by naming it.
    const ws = await splitWs()
    const blind = ws.getSession('blind')
    const seen = await runWithSession(blind, () => ws.vfs.exists('/data/secret.txt', 'seeing'))
    expect(seen).toBe(false)
  })

  it("falls back to the facade's own session when none is named", async () => {
    const ws = await splitWs()
    expect(await new Session(ws, 'blind').vfs.exists('/data/secret.txt')).toBe(false)
    expect(await ws.vfs.exists('/data/secret.txt')).toBe(true)
  })
})
