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
import { OpsRegistry } from '../ops/registry.ts'
import type { Policy } from '../policy/base.ts'
import { PolicyDenied } from '../policy/errors.ts'
import { Policies } from '../policy/policies.ts'
import type { Action, OpsContext, OpsResultContext } from '../policy/types.ts'
import { MountNotAllowedError } from '../context/session_context.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { FileType, Limit, MountMode } from '../types.ts'
import { enoent, enotdir } from '../utils/errors.ts'
import { WorkspaceFS } from './fs.ts'
import { Workspace } from './workspace.ts'

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

describe('WorkspaceFS', () => {
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

describe('WorkspaceFS existence probes', () => {
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
describe('WorkspaceFS policy door', () => {
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

// The resolver-miss structure fallback (a directory that exists only
// because a mount sits below it) answers with no owning mount, so the
// gates fire with prefix '' — skipping them would make "no mount here"
// a policy bypass.
describe('WorkspaceFS structure fallback still clears admission', () => {
  class SealInner implements Policy {
    preOps(ctx: OpsContext): Action | null {
      if (ctx.path.virtual === '/data/inner') return { kind: 'deny', message: 'sealed\n' }
      return null
    }
  }

  function mkStructureFS(policies: Policies): WorkspaceFS {
    return new WorkspaceFS(
      () => Promise.reject(enoent('/data/inner')),
      new OpsRegistry(),
      null,
      null,
      null,
      policies,
      () => '',
      () => ['/data/inner/deep/'],
    )
  }

  it('a policy deny covers the synthetic readdir and stat', async () => {
    const policies = new Policies()
    policies.add(new SealInner())
    const fs = mkStructureFS(policies)
    await expect(fs.readdir('/data/inner')).rejects.toThrow(PolicyDenied)
    await expect(fs.stat('/data/inner')).rejects.toThrow(PolicyDenied)
  })

  it('the synthetic answer serves when no policy objects', async () => {
    const fs = mkStructureFS(new Policies())
    expect(await fs.readdir('/data/inner')).toEqual(['/data/inner/deep'])
  })
})

describe('WorkspaceFS structure below an ungranted mount', () => {
  function mkUngrantedFS(prefixes: string[]): WorkspaceFS {
    return new WorkspaceFS(
      () => Promise.reject(new MountNotAllowedError('agent', '/data')),
      new OpsRegistry(),
      null,
      null,
      null,
      new Policies(),
      () => '',
      () => prefixes,
    )
  }

  it('serves the granted structure instead of the denial', async () => {
    // The resolver rejects because the owning mount is ungranted, but a
    // granted mount below the path already put its name in a listing,
    // so walking down to the grant must answer.
    const fs = mkUngrantedFS(['/data/inner/deep/'])
    expect(await fs.readdir('/data/inner')).toEqual(['/data/inner/deep'])
    const st = await fs.stat('/data/inner')
    expect(st.type).toBe(FileType.DIRECTORY)
  })

  it('a path the structure does not owe keeps the canonical denial', async () => {
    const fs = mkUngrantedFS([])
    await expect(fs.readdir('/data/inner')).rejects.toThrow(MountNotAllowedError)
    await expect(fs.stat('/data/inner')).rejects.toThrow(MountNotAllowedError)
  })

  it("gates the fallback with the synthetic '' prefix, not the ungranted mount's", async () => {
    // prefixOf still resolves the real ungranted '/data/' here, but the
    // namespace's own answer has no owning mount: the gates must see ''
    // exactly as the dispatcher and both Python doors report it, or a
    // mount-scoped policy diverges between ws.readdir and ws.dispatch.
    const seen: string[] = []
    class RecordPrefix implements Policy {
      preOps(ctx: OpsContext): Action | null {
        seen.push(ctx.prefix)
        return null
      }
    }
    const policies = new Policies()
    policies.add(new RecordPrefix())
    const fs = new WorkspaceFS(
      () => Promise.reject(new MountNotAllowedError('agent', '/data')),
      new OpsRegistry(),
      null,
      null,
      null,
      policies,
      () => '/data/',
      () => ['/data/inner/deep/'],
    )
    expect(await fs.readdir('/data/inner')).toEqual(['/data/inner/deep'])
    await fs.stat('/data/inner')
    expect(seen).toEqual(['', ''])
  })
})
