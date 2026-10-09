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
import type { Accessor } from '../../../accessor/base.ts'
import {
  runWithAdmission,
  runWithMountGate,
  runWithSession,
} from '../../../context/session_context.ts'
import { IOResult } from '../../../io/types.ts'
import type { Policy } from '../../../policy/base.ts'
import { Policies, runWithOpPolicies } from '../../../policy/policies.ts'
import type { Action, VfsContext } from '../../../policy/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import {
  requireOp,
  withAbortGuard,
  withCommandGuards,
  withDispatchRuleGuard,
  withPolicyGuard,
} from './adapter.ts'
import { ContentType, FileStat, FileType, MountMode, PathSpec } from '../../../types.ts'
import { eacces, eisdir, enoent } from '../../../errors/fs.ts'
import { formatFsError } from '../../../errors/render.ts'
import { stripSlash } from '../../../utils/slash.ts'
import { SessionState } from '../../../workspace/session/session.ts'
import type { CommandOpts, CommandIO } from '../../config.ts'
import {
  commandIo,
  dirAwareStat,
  dirAwareStream,
  resolveGlobOf,
  scopedIo,
  withDirGuard,
} from './adapter.ts'
import { BaseVFS } from '../../../vfs/base.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { makeResolveGlob } from '../../../utils/glob_walk.ts'

const accessor = {} as never
// No namespace facts, which is what a command bound outside a workspace
// gets: the two probes below the backend are the only ones that can fire.
const NO_NS = {} as CommandOpts
// The one a mount parent needs: no backend row, a name plane that owes the
// path a child name.
function nsDir(dir: string): CommandOpts {
  return {
    ns: { childMounts: (parent: string) => (parent === dir ? ['alpha'] : []) },
  } as CommandOpts
}

function glob(dir: string, pattern: string): PathSpec {
  return new PathSpec({
    vfsPath: stripSlash(dir),
    virtual: dir,
    directory: dir,
    pattern,
    resolved: false,
  })
}

// Stores bytes as RAM does and renders `.tally` reads on top of them.
class TallyRAM extends RAMVFS {
  override readonly renderers: Readonly<Record<string, string>> = { '.tally': 'readTally' }

  readTally(): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode('RENDERED'))
  }
}

// Renders `.tally` reads and stores nothing else, as gdocs does.
class TallyOnly extends BaseVFS {
  override readonly renderers: Readonly<Record<string, string>> = { '.tally': 'readTally' }

  readTally(): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode('RENDERED'))
  }
}

describe('commandIo', () => {
  const books = new PathSpec({ virtual: '/books.tally', directory: '/', vfsPath: 'books.tally' })

  // A command writes back what it read (sed -i), so it reads the stored
  // bytes wherever the VFS stores any.
  it('reads the stored bytes of a VFS that defines read', async () => {
    const vfs = new TallyRAM()
    await vfs.write(books, new TextEncoder().encode('STORED'))
    const read = await commandIo(vfs).readBytes(vfs.accessor, books)
    expect(new TextDecoder().decode(read)).toBe('STORED')
  })

  it('reads the rendering of a VFS that only renders', async () => {
    const vfs = new TallyOnly()
    const read = await commandIo(vfs).readBytes(vfs.accessor, books)
    expect(new TextDecoder().decode(read)).toBe('RENDERED')
  })
})

describe('resolveGlobOf', () => {
  it('lets a trailing slash ask the namespace about an owed name', async () => {
    // The factory stamps the invocation's link target stat beside the
    // owed child names; the resolver drops a link to nothing the way
    // bash does and keeps a link to a directory.
    const readdir = () => Promise.resolve(['/d/alpha'])
    const stat = () => Promise.resolve(new FileStat({ name: 'alpha', type: FileType.DIRECTORY }))
    const ops: CommandIO = {
      readdir,
      readBytes: () => Promise.resolve(new Uint8Array()),
      readStream: () => oneChunkStream(new Uint8Array()),
      stat,
      isMounted: () => true,
      globChildren: (parent) => (parent === '/d/' ? ['broken', 'lnk'] : []),
      globTargetStat: (virtual) =>
        Promise.resolve(
          virtual === '/d/lnk' ? new FileStat({ name: 'lnk', type: FileType.DIRECTORY }) : null,
        ),
    }
    const word = new PathSpec({
      virtual: '/d/*',
      directory: '/d/',
      vfsPath: '*',
      pattern: '*',
      resolved: false,
      rawPath: '/d/*/',
    })
    const out = await resolveGlobOf(ops)(accessor, [word])
    expect(out.map((p) => p.rawPath)).toEqual(['/d/alpha/', '/d/lnk/'])
  })
})

describe('makeResolveGlob', () => {
  it('expands a glob pattern against readdir', async () => {
    const readdir = () => Promise.resolve(['/d/a.txt', '/d/b.log', '/d/c.txt'])
    const resolveGlob = makeResolveGlob(readdir)
    const out = await resolveGlob(accessor, [glob('/d/', '*.txt')])
    expect(out.map((p) => p.virtual).sort()).toEqual(['/d/a.txt', '/d/c.txt'])
    expect(out.every((p) => p.resolved)).toBe(true)
  })

  it('passes an already-resolved path through unchanged', async () => {
    const readdir = () => Promise.reject(new Error('should not readdir'))
    const resolveGlob = makeResolveGlob(readdir)
    const p = new PathSpec({
      vfsPath: 'd/a.txt',
      virtual: '/d/a.txt',
      directory: '/d/',
      resolved: true,
    })
    const out = await resolveGlob(accessor, [p])
    expect(out).toEqual([p])
  })

  it('truncates matches beyond maxGlobMatches', async () => {
    const readdir = () => Promise.resolve(['/d/a.txt', '/d/b.txt', '/d/c.txt'])
    const resolveGlob = makeResolveGlob(readdir, 2)
    const out = await resolveGlob(accessor, [glob('/d/', '*.txt')])
    expect(out).toHaveLength(2)
  })

  it('passes a plain non-pattern unresolved path through', async () => {
    const readdir = () => Promise.reject(new Error('should not readdir'))
    const resolveGlob = makeResolveGlob(readdir)
    const p = new PathSpec({
      vfsPath: 'd/a.txt',
      virtual: '/d/a.txt',
      directory: '/d/',
      resolved: false,
    })
    const out = await resolveGlob(accessor, [p])
    expect(out).toEqual([p])
  })
})

// eslint-disable-next-line @typescript-eslint/require-await
async function* dataStream(): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode('data')
}

function dirOps(implicitDirs: readonly string[], explicitDirs: readonly string[] = []): CommandIO {
  return {
    readdir: (_a, p) => {
      const target = `/${stripSlash(p.virtual)}`
      const entries = implicitDirs.filter((d) => (d.slice(0, d.lastIndexOf('/')) || '/') === target)
      if (implicitDirs.includes(p.virtual))
        entries.push(`${target === '/' ? '' : target}/child.txt`)
      return Promise.resolve(entries)
    },
    readBytes: () => Promise.resolve(new Uint8Array()),
    readStream: (_a, p) => {
      if (implicitDirs.includes(p.virtual)) throw enoent(p)
      return dataStream()
    },
    stat: (_a, p) => {
      if (implicitDirs.includes(p.virtual)) return Promise.reject(enoent(p))
      if (explicitDirs.includes(p.virtual))
        return Promise.resolve(new FileStat({ name: p.virtual, type: FileType.DIRECTORY }))
      return Promise.resolve(new FileStat({ name: p.virtual, type: FileType.FILE, size: 0 }))
    },
    isMounted: () => true,
  }
}

describe('dirAwareStat', () => {
  it('refuses an implicit keyed-backend directory with EISDIR', async () => {
    const stat = dirAwareStat(dirOps(['/sub']), accessor, NO_NS)
    await expect(stat(PathSpec.fromStrPath('/sub'))).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('refuses a stat-typed directory with EISDIR', async () => {
    const stat = dirAwareStat(dirOps([], ['/sub']), accessor, NO_NS)
    await expect(stat(PathSpec.fromStrPath('/sub'))).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('keeps ENOENT for a genuinely missing path', async () => {
    const failing: CommandIO = { ...dirOps([]), stat: (_a, p) => Promise.reject(enoent(p)) }
    const stat = dirAwareStat(failing, accessor, NO_NS)
    await expect(stat(PathSpec.fromStrPath('/nope.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a namespace-only mount parent with EISDIR', async () => {
    // No backend knows the path: its keys live in a mount nested under it,
    // so neither the stat nor the parent-listing probe can see it, and the
    // dispatcher is the only thing that can say it is a directory.
    const failing: CommandIO = { ...dirOps([]), stat: (_a, p) => Promise.reject(enoent(p)) }
    const stat = dirAwareStat(failing, accessor, nsDir('/ghost'))
    await expect(stat(PathSpec.fromStrPath('/ghost'))).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('keeps ENOENT when the dispatcher does not know the path either', async () => {
    const failing: CommandIO = { ...dirOps([]), stat: (_a, p) => Promise.reject(enoent(p)) }
    const stat = dirAwareStat(failing, accessor, nsDir('/elsewhere'))
    await expect(stat(PathSpec.fromStrPath('/ghost'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('ignores fabricated children from synthetic hierarchies', async () => {
    // A postgres-style backend answers a readdir of any missing name with
    // fabricated children; only the parent listing decides.
    const lying: CommandIO = {
      ...dirOps([]),
      stat: (_a, p) => Promise.reject(enoent(p)),
      readdir: (_a, p) => {
        const target = `/${stripSlash(p.virtual)}`
        if (target === '/') return Promise.resolve(['/real.txt'])
        return Promise.resolve([`${target}/tables`, `${target}/views`])
      },
    }
    const stat = dirAwareStat(lying, accessor, NO_NS)
    await expect(stat(PathSpec.fromStrPath('/nope.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps ENOENT when the probe readdir raises a driver error', async () => {
    const throwing: CommandIO = {
      ...dirOps([]),
      stat: (_a, p) => Promise.reject(enoent(p)),
      readdir: () => Promise.reject(new Error("Table 'nope.txt' was not found")),
    }
    const stat = dirAwareStat(throwing, accessor, NO_NS)
    await expect(stat(PathSpec.fromStrPath('/nope.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('passes regular files through', async () => {
    const stat = dirAwareStat(dirOps([]), accessor, NO_NS)
    await expect(stat(PathSpec.fromStrPath('/f.txt'))).resolves.toMatchObject({ size: 0 })
  })
})

describe('dirAwareStream', () => {
  it('refuses an implicit directory with EISDIR when consumed', async () => {
    const stream = dirAwareStream(dirOps(['/sub']), accessor, NO_NS)
    const consume = async () => {
      for await (const chunk of stream(PathSpec.fromStrPath('/sub'))) {
        throw new Error(`no data expected, got ${String(chunk.byteLength)} bytes`)
      }
    }
    await expect(consume()).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('refuses a stat-typed directory before the backend read runs', async () => {
    // sftp reads of a directory raise an opaque `Failure`; the stat-first
    // check must win so the generic formats GNU's `Is a directory`.
    const sshLike: CommandIO = {
      ...dirOps([], ['/sub']),
      readStream: () => {
        throw new Error('Failure')
      },
    }
    const stream = dirAwareStream(sshLike, accessor, NO_NS)
    const consume = async () => {
      for await (const chunk of stream(PathSpec.fromStrPath('/sub'))) {
        throw new Error(`no data expected, got ${String(chunk.byteLength)} bytes`)
      }
    }
    await expect(consume()).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('streams regular files untouched', async () => {
    const stream = dirAwareStream(dirOps([]), accessor, NO_NS)
    const chunks: Uint8Array[] = []
    for await (const chunk of stream(PathSpec.fromStrPath('/f.txt'))) chunks.push(chunk)
    expect(new TextDecoder().decode(chunks[0])).toBe('data')
  })
})

// A keyed backend: no directory objects, so a read of one misses. Reads
// throw `readError` for anything that is not a stored file, which is
// what RAM/S3/Redis do for a directory (there is no key there) and what
// an sftp read of a directory does with a non-FsError (SFTPFailure).
// eslint-disable-next-line @typescript-eslint/require-await
async function* oneChunkStream(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data
}

// A stream that fails on the first pull, which is where a keyed backend
// reports a directory: there is no key, so the read raises rather than
// the call.
// eslint-disable-next-line @typescript-eslint/require-await, require-yield
async function* throwingStream(err: Error): AsyncIterable<Uint8Array> {
  throw err
}

function keyedReadOps(opts: {
  implicitDirs?: readonly string[]
  explicitDirs?: readonly string[]
  files?: Record<string, string>
  readError?: (p: PathSpec) => Error
  children?: Record<string, string[]>
}): CommandIO {
  const implicitDirs = opts.implicitDirs ?? []
  const explicitDirs = opts.explicitDirs ?? []
  const files = opts.files ?? {}
  const readError = opts.readError ?? ((p: PathSpec) => enoent(p))
  const children = opts.children
  const encode = (t: string) => new TextEncoder().encode(t)
  return {
    readdir: (_a, p) => {
      const target = `/${stripSlash(p.virtual)}`
      const entries = implicitDirs.filter((d) => (d.slice(0, d.lastIndexOf('/')) || '/') === target)
      if (implicitDirs.includes(p.virtual))
        entries.push(`${target === '/' ? '' : target}/child.txt`)
      return Promise.resolve(entries)
    },
    readBytes: (_a, p) => {
      const hit = files[p.virtual]
      if (hit !== undefined) return Promise.resolve(encode(hit))
      return Promise.reject(readError(p))
    },
    readRange: (_a, p) => {
      const hit = files[p.virtual]
      if (hit !== undefined) return Promise.resolve(encode(hit))
      return Promise.reject(readError(p))
    },
    readStream: (_a, p) => {
      const hit = files[p.virtual]
      return hit === undefined ? throwingStream(readError(p)) : oneChunkStream(encode(hit))
    },
    stat: (_a, p) => {
      if (explicitDirs.includes(p.virtual))
        return Promise.resolve(new FileStat({ name: p.virtual, type: FileType.DIRECTORY }))
      const hit = files[p.virtual]
      if (hit !== undefined)
        return Promise.resolve(
          new FileStat({ name: p.virtual, type: FileType.FILE, size: hit.length }),
        )
      return Promise.reject(enoent(p))
    },
    isMounted: () => true,
    ...(children === undefined ? {} : { globChildren: (dir: string) => children[dir] ?? [] }),
  }
}

async function drain(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

describe('withDispatchRuleGuard', () => {
  const spec = (virtual: string): PathSpec =>
    new PathSpec({
      virtual,
      directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
      vfsPath: virtual,
      resolved: true,
    })

  it('marks an op with the bound gate for the dispatcher to judge', async () => {
    const seen: [string, unknown][] = []
    const inner: DispatchFn = (op, _path, _args, kwargs) => {
      seen.push([op, kwargs?.ruleGate])
      return Promise.resolve([null, new IOResult()])
    }
    const dispatch = withDispatchRuleGuard(inner)
    // No gate bound: the op goes to the dispatcher unmarked.
    await dispatch('read', spec('/data/f'))
    const asked: string[] = []
    const gate = {
      scoped: true,
      scopes: () => true,
      granted: [],
      check: (virtual: string) => {
        asked.push(virtual)
      },
      refuses: () => false,
    }
    await runWithAdmission(gate, async () => {
      await dispatch('read', spec('/data/f'), [spec('/data/g')])
      // A metadata op is never judged: deny is present and refused.
      await dispatch('stat', spec('/data/f'))
    })
    expect(seen).toEqual([
      ['read', undefined],
      ['read', gate],
      ['stat', undefined],
    ])
    // The wrapper judges nothing itself: the dispatcher does, on its own paths.
    expect(asked).toEqual([])
  })
})

describe('scopedIo', () => {
  it('sets a content index aside', () => {
    // A content index names files under a listing a rule may refuse, so a
    // scoped command walks the guarded readdir instead, as it does for
    // every other native scan.
    const index = { narrowPaths: () => Promise.resolve([]), enabled: () => true }
    const io: CommandIO = { ...dirOps([]), contentSearch: index }
    const roots = [PathSpec.fromStrPath('/data')]
    const free = { scoped: () => false }
    const judged = { scoped: (virtual: string) => virtual === '/data' }
    expect(scopedIo(io, free, roots, '/data/').contentSearch).toBe(index)
    expect(scopedIo(io, undefined, roots, '/data/').contentSearch).toBe(index)
    expect(scopedIo(io, judged, roots, '/data/').contentSearch).toBeUndefined()
  })
})

const SEALED = { message: 'Permission denied', refusal: { reason: 'sealed' } }

class SealedRead implements Policy {
  readonly asked: [string, string, boolean][] = []
  private readonly sealed: string
  constructor(sealed: string) {
    this.sealed = sealed
  }
  preVfs(ctx: VfsContext): Action | null {
    this.asked.push([ctx.op, ctx.path.virtual, ctx.write])
    if (!ctx.write && ctx.path.virtual === this.sealed) {
      return { kind: 'deny', reason: 'sealed' }
    }
    return null
  }
}

describe('withPolicyGuard', () => {
  const spec = (virtual: string): PathSpec =>
    new PathSpec({
      virtual,
      directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
      vfsPath: virtual,
      resolved: true,
    })

  function probeOps(calls: string[][]): CommandIO {
    async function* stream(_a: Accessor, path: PathSpec): AsyncGenerator<Uint8Array> {
      calls.push(['stream', path.virtual])
      yield await Promise.resolve(new Uint8Array([1]))
    }
    return {
      readdir: (_a, path) => {
        calls.push(['readdir', path.virtual])
        return Promise.resolve(['a'])
      },
      readBytes: (_a, path) => {
        calls.push(['read', path.virtual])
        return Promise.resolve(new Uint8Array([1]))
      },
      readStream: stream,
      stat: (_a, path) => {
        calls.push(['stat', path.virtual])
        return Promise.resolve(
          new FileStat({ name: 'k', type: FileType.FILE, content: ContentType.TEXT, size: 1 }),
        )
      },
      isMounted: () => true,
      copy: (_a, src, dst) => {
        calls.push(['copy', src.virtual, dst.virtual])
        return Promise.resolve()
      },
      unlink: (_a, path) => {
        calls.push(['unlink', path.virtual])
        return Promise.resolve()
      },
    }
  }

  it('admits slots and leaves stat alone', async () => {
    const calls: string[][] = []
    const raw = probeOps(calls)
    // No binding: every slot runs as is, and no hook fires.
    expect(await withPolicyGuard(raw).readBytes(accessor, spec('/data/secret'))).toEqual(
      new Uint8Array([1]),
    )
    calls.length = 0

    const policy = new SealedRead('/data/secret')
    await runWithOpPolicies(new Policies([policy]), () =>
      runWithMountGate('/data', MountMode.WRITE, async () => {
        const ops = withPolicyGuard(raw)
        // Content reads are the dispatcher's, which admits them itself.
        expect(ops.readBytes).toBe(raw.readBytes)
        expect(ops.readStream).toBe(raw.readStream)
        // stat is not a guarded slot: deny is present and refused.
        expect((await ops.stat(accessor, spec('/data/secret'))).size).toBe(1)
        // readdir asks about the directory it lists.
        await expect(ops.readdir(accessor, spec('/data/secret'))).rejects.toMatchObject(SEALED)
        expect(calls).not.toContainEqual(['readdir', '/data/secret'])
        expect(await ops.readdir(accessor, spec('/data/dir'))).toEqual(['a'])
        // A copy's source is a read; its destination is a write.
        const copy = ops.copy
        if (copy === undefined) throw new Error('copy slot missing')
        await copy(accessor, spec('/data/src'), spec('/data/dst'))
        // The other writes are the dispatcher's too.
        expect(ops.unlink).toBe(raw.unlink)
      }),
    )
    expect(policy.asked).toContainEqual(['readdir', '/data/dir', false])
    expect(policy.asked).toContainEqual(['copy', '/data/src', false])
    expect(policy.asked).toContainEqual(['copy', '/data/dst', true])
    expect(policy.asked.some(([op]) => op === 'stat')).toBe(false)
  })

  it('wrap-time capture covers late calls', async () => {
    // A slot called after dispatch has reset the context is still admitted
    // by the scope the guard captured at wrap time (livePolicyScope).
    const calls: string[][] = []
    const raw = probeOps(calls)
    const policy = new SealedRead('/data/secret')
    const ops = await runWithOpPolicies(new Policies([policy]), () =>
      Promise.resolve(withPolicyGuard(raw)),
    )
    // The slot call happens outside the window now.
    await expect(ops.readdir(accessor, spec('/data/secret'))).rejects.toMatchObject(SEALED)
    expect(calls).not.toContainEqual(['readdir', '/data/secret'])
  })
})

describe('withDirGuard', () => {
  it('refuses an explicit directory on every read slot', async () => {
    const ops = withDirGuard(keyedReadOps({ explicitDirs: ['/sub'] }))
    const p = PathSpec.fromStrPath('/sub')
    await expect(ops.readBytes(accessor, p, undefined)).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(ops.readRange?.(accessor, p, undefined, 0, null)).rejects.toMatchObject({
      code: 'EISDIR',
    })
    await expect(drain(ops.readStream(accessor, p, undefined))).rejects.toMatchObject({
      code: 'EISDIR',
    })
  })

  it('refuses an implicit keyed-backend directory', async () => {
    const ops = withDirGuard(keyedReadOps({ implicitDirs: ['/sub'] }))
    const p = PathSpec.fromStrPath('/sub')
    await expect(ops.readBytes(accessor, p, undefined)).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(drain(ops.readStream(accessor, p, undefined))).rejects.toMatchObject({
      code: 'EISDIR',
    })
  })

  it('refuses a namespace-only directory', async () => {
    // /a/b holds no key in this backend; it exists because a mount or a
    // link sits under it, which only the namespace can see.
    const ops = withDirGuard(keyedReadOps({ children: { '/a/b': ['inner'] } }))
    await expect(
      ops.readBytes(accessor, PathSpec.fromStrPath('/a/b'), undefined),
    ).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('refines a read failure that is not an FsError at all', async () => {
    // An sftp read of a directory throws asyncssh's SFTPFailure, which
    // carries no errno, so the code-only path cannot see it. The stat
    // says directory, and that is what decides.
    const ops = withDirGuard(
      keyedReadOps({
        explicitDirs: ['/sub'],
        readError: () => new Error('SFTP protocol failure'),
      }),
    )
    await expect(
      ops.readBytes(accessor, PathSpec.fromStrPath('/sub'), undefined),
    ).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('leaves a real miss alone', async () => {
    const ops = withDirGuard(keyedReadOps({}))
    const p = PathSpec.fromStrPath('/nope.txt')
    await expect(ops.readBytes(accessor, p, undefined)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(drain(ops.readStream(accessor, p, undefined))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('leaves a successful read alone', async () => {
    const ops = withDirGuard(keyedReadOps({ files: { '/f.txt': 'data' } }))
    const p = PathSpec.fromStrPath('/f.txt')
    expect(new TextDecoder().decode(await ops.readBytes(accessor, p, undefined))).toBe('data')
    expect(new TextDecoder().decode((await drain(ops.readStream(accessor, p, undefined)))[0])).toBe(
      'data',
    )
  })

  it('names the virtual path, not the backend one', async () => {
    // A raw disk error names the host path; the refusal is built from the
    // operand's own PathSpec so the mount's host root never leaks.
    const ops = withDirGuard(
      keyedReadOps({
        explicitDirs: ['/mnt/sub'],
        readError: () => eisdir('/private/var/host/sub'),
      }),
    )
    await expect(
      ops.readBytes(accessor, PathSpec.fromStrPath('/mnt/sub'), undefined),
    ).rejects.toMatchObject({ code: 'EISDIR', message: '/mnt/sub' })
  })

  it('keeps the read own error when a probe blows up', async () => {
    // A probe that fails is a negative probe. Surfacing it would swap the
    // read's error for one from a call the user never made.
    const ops = withDirGuard({
      readdir: () => Promise.reject(new Error('transport reset')),
      readBytes: (_a, p) => Promise.reject(eacces(p.virtual)),
      readStream: () => {
        throw new Error('not used')
      },
      stat: () => Promise.reject(new Error('transport reset')),
      isMounted: () => true,
    })
    await expect(
      ops.readBytes(accessor, PathSpec.fromStrPath('/locked.txt'), undefined),
    ).rejects.toMatchObject({ code: 'EACCES' })
  })
})

describe('withAbortGuard', () => {
  const spec = (virtual: string): PathSpec =>
    new PathSpec({
      virtual,
      directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
      vfsPath: virtual,
      resolved: true,
    })

  function recording(calls: string[]): CommandIO {
    return {
      readdir: (_a, path) => {
        calls.push(`readdir ${path.virtual}`)
        return Promise.resolve([])
      },
      readBytes: (_a, path) => {
        calls.push(`read ${path.virtual}`)
        return Promise.resolve(new Uint8Array([1]))
      },
      readStream: (_a, path) => {
        calls.push(`stream ${path.virtual}`)
        return (async function* () {
          yield await Promise.resolve(new Uint8Array([1]))
        })()
      },
      stat: (_a, path) => {
        calls.push(`stat ${path.virtual}`)
        return Promise.resolve(
          new FileStat({ name: 'k', type: FileType.FILE, content: ContentType.TEXT, size: 1 }),
        )
      },
      isMounted: () => true,
      exists: (_a, path) => {
        calls.push(`exists ${path.virtual}`)
        return Promise.resolve(true)
      },
      find: (_a, path) => {
        calls.push(`find ${path.virtual}`)
        return Promise.resolve([])
      },
      du: {
        size: (_a, path) => {
          calls.push(`du.size ${path.virtual}`)
          return Promise.resolve(0)
        },
        entries: (_a, path) => {
          calls.push(`du.entries ${path.virtual}`)
          return Promise.resolve([[], 0] as [[string, number][], number])
        },
      },
      unlink: (_a, path) => {
        calls.push(`unlink ${path.virtual}`)
        return Promise.resolve()
      },
      write: (_a, path) => {
        calls.push(`write ${path.virtual}`)
        return Promise.resolve()
      },
    }
  }

  it('forwards every slot while the signal is quiet', async () => {
    const calls: string[] = []
    const guarded = withAbortGuard(recording(calls), new AbortController().signal)
    await guarded.unlink?.(accessor, spec('/data/a'))
    await guarded.readBytes(accessor, spec('/data/a'))
    expect(calls).toEqual(['unlink /data/a', 'read /data/a'])
  })

  it('refuses to start a slot once the signal fired', async () => {
    const calls: string[] = []
    const controller = new AbortController()
    const guarded = withAbortGuard(recording(calls), controller.signal)
    controller.abort(new Error('released'))
    await expect(guarded.unlink?.(accessor, spec('/data/b'))).rejects.toMatchObject({
      name: 'AbortError',
      cause: { message: 'released' },
    })
    await expect(
      guarded.write?.(accessor, spec('/data/b'), new Uint8Array()),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(guarded.readdir(accessor, spec('/data'))).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(calls).toEqual([])
  })

  // A presence fact costs no write, which is why the policy guard lets
  // it through, but on an API mount it is still a request. `stat a b`
  // whose first call outlives the grace would otherwise start the
  // second after the caller was released.
  it('refuses the presence facts too', async () => {
    const calls: string[] = []
    const controller = new AbortController()
    const guarded = withAbortGuard(recording(calls), controller.signal)
    controller.abort(new Error('released'))
    await expect(guarded.stat(accessor, spec('/data/b'))).rejects.toMatchObject({
      name: 'AbortError',
      cause: { message: 'released' },
    })
    await expect(guarded.exists?.(accessor, spec('/data/b'))).rejects.toMatchObject({
      name: 'AbortError',
    })
    await expect(guarded.find?.(accessor, spec('/data'), {})).rejects.toMatchObject({
      name: 'AbortError',
    })
    await expect(guarded.du?.size(accessor, spec('/data'))).rejects.toMatchObject({
      name: 'AbortError',
    })
    await expect(guarded.du?.entries(accessor, spec('/data'))).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(calls).toEqual([])
  })

  it('is the ops themselves without a signal', () => {
    const ops = recording([])
    expect(withAbortGuard(ops, undefined)).toBe(ops)
  })
})

function capabilityOps(backend?: () => Promise<void>): CommandIO {
  return {
    readdir: () => Promise.resolve([]),
    readBytes: () => Promise.resolve(new Uint8Array()),
    readStream: () => oneChunkStream(new Uint8Array()),
    // The regions stand as directories, so a mkdir of `f` inside one is a
    // real create and answers the region's own refusal (a missing parent
    // would be ENOENT, as GNU says). Mirrors test_adapter.py.
    stat: (_accessor, path) =>
      ['/data/locked', '/data/hidden', '/data/build'].includes(path.virtual)
        ? Promise.resolve(new FileStat({ type: FileType.DIRECTORY, name: path.virtual }))
        : Promise.reject(enoent(path.virtual)),
    isMounted: () => true,
    ...(backend === undefined
      ? {}
      : {
          write: backend,
          mkdir: backend,
          unlink: backend,
          copy: backend,
          rename: backend,
          truncate: backend,
        }),
  }
}

// A write slot the backend has is the dispatcher's (`dispatchedIo`), which
// judges it itself; the guards hold a missing one and a copy.
const capabilityCases = [
  ...(['write', 'mkdir', 'unlink', 'rename', 'copy', 'truncate'] as const).map((operation) => ({
    available: false,
    operation,
  })),
  { available: true, operation: 'copy' as const },
].flatMap(({ available, operation }) =>
  (['locked', 'hidden', 'build'] as const).map((region) => ({ available, operation, region })),
)

it.each(capabilityCases)(
  'guards $operation in $region, available=$available',
  async ({ available, operation, region }) => {
    let calls = 0
    const backend = () => {
      calls++
      return Promise.resolve()
    }
    const session = new SessionState({
      sessionId: 'guard-matrix',
      mountModes: new Map([['/data', MountMode.READ]]),
      visibility: {
        paths: { paths: ['/data/hidden'] },
        shown: { entries: [{ path: '/data/build', mode: MountMode.WRITE }] },
      },
    })
    await runWithSession(session, () =>
      runWithMountGate('/data', MountMode.WRITE, async () => {
        const ops = withCommandGuards(capabilityOps(available ? backend : undefined))
        const path = PathSpec.fromStrPath(`/data/${region}/f`)
        const invoke = () => {
          if (operation === 'copy' || operation === 'rename') {
            return requireOp(ops[operation], operation)(
              accessor,
              PathSpec.fromStrPath('/data/build/src'),
              path,
            )
          }
          if (operation === 'write')
            return requireOp(ops.write, operation)(accessor, path, new Uint8Array())
          if (operation === 'truncate') return requireOp(ops.truncate, operation)(accessor, path, 0)
          return requireOp(ops[operation], operation)(accessor, path)
        }
        if (available && region === 'build') {
          await invoke()
          expect(calls).toBe(1)
        } else {
          const code = { locked: 'EROFS', hidden: 'ENOENT', build: 'ENOTSUP' }[region]
          const named =
            operation === 'rename' && region === 'build' ? '/data/build/src' : path.virtual
          await expect(invoke()).rejects.toMatchObject({ code, virtualPath: named })
          expect(calls).toBe(0)
          if (region === 'locked') {
            const err = await invoke().catch((e: unknown) => e)
            expect(new TextDecoder().decode(formatFsError('probe', err))).toBe(
              `probe: ${path.virtual}: Read-only file system\n`,
            )
          }
        }
      }),
    )
  },
)

it.each([false, true])(
  'copy reads source; rename mutates source and subtree, available=%s',
  async (available) => {
    let calls = 0
    const backend = () => {
      calls++
      return Promise.resolve()
    }
    const session = new SessionState({
      sessionId: 'pair-guards',
      visibility: {
        shown: {
          entries: [
            { path: '/data/src', mode: MountMode.READ },
            { path: '/data/tree/locked', mode: MountMode.READ },
          ],
        },
      },
    })
    await runWithSession(session, () =>
      runWithMountGate('/data', MountMode.WRITE, async () => {
        const table = capabilityOps(available ? backend : undefined)
        // A rename the backend has is the dispatcher's, so the guards judge
        // only a missing one.
        delete table.rename
        const ops = withCommandGuards(table)
        const src = PathSpec.fromStrPath('/data/src'),
          dst = PathSpec.fromStrPath('/data/dst')
        const copy = requireOp(ops.copy, 'copy')
        if (available) await copy(accessor, src, dst)
        else
          await expect(copy(accessor, src, dst)).rejects.toMatchObject({
            code: 'ENOTSUP',
            virtualPath: dst.virtual,
          })
        for (const [source, blame] of [
          [src, src.virtual],
          [PathSpec.fromStrPath('/data/tree'), '/data/tree/locked'],
        ] as const) {
          await expect(
            Promise.resolve().then(() => requireOp(ops.rename, 'rename')(accessor, source, dst)),
          ).rejects.toMatchObject({ code: 'EROFS', virtualPath: blame })
        }
        expect(calls).toBe(Number(available))
      }),
    )
  },
)

it('a missing copy checks command paths before capability failure', async () => {
  const checked: string[] = []
  await runWithAdmission(
    {
      scoped: true,
      scopes: () => true,
      granted: [],
      check: (path) => {
        checked.push(path)
        throw new Error('sealed')
      },
      refuses: () => true,
    },
    async () => {
      await expect(
        requireOp<NonNullable<CommandIO['copy']>>(undefined, 'copy')(
          accessor,
          PathSpec.fromStrPath('/data/secret'),
          PathSpec.fromStrPath('/data/dst'),
        ),
      ).rejects.toThrow('sealed')
    },
  )
  expect(checked).toEqual(['/data/secret'])
})

describe('directory EOF', () => {
  it.each([false, true])('distinguishes empty files from directories: %s', async (isDir) => {
    const ops = withDirGuard(
      keyedReadOps({
        explicitDirs: isDir ? ['/empty'] : [],
        files: { '/empty': '' },
      }),
    )
    const path = PathSpec.fromStrPath('/empty')
    if (isDir) {
      await expect(ops.readBytes(accessor, path)).rejects.toMatchObject({ code: 'EISDIR' })
      await expect(drain(ops.readStream(accessor, path))).rejects.toMatchObject({ code: 'EISDIR' })
      await expect(ops.readRange?.(accessor, path, undefined, 0, null)).rejects.toMatchObject({
        code: 'EISDIR',
      })
    } else {
      expect(await ops.readBytes(accessor, path)).toEqual(new Uint8Array())
      expect(await drain(ops.readStream(accessor, path))).toEqual([new Uint8Array()])
      expect(await ops.readRange?.(accessor, path, undefined, 0, null)).toEqual(new Uint8Array())
    }
  })
})
