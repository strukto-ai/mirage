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

import { stripSlash } from '../../../utils/slash.ts'
import { describe, expect, it } from 'vitest'
import type { Accessor } from '../../../accessor/base.ts'
import type { CommandOpts } from '../../config.ts'
import { ContentType, FileStat, FileType, MountMode, PathSpec } from '../../../types.ts'
import { eacces, eisdir, enoent } from '../../../utils/errors.ts'
import {
  dirAwareStat,
  dirAwareStream,
  makeResolveGlob,
  withDirGuard,
  withHiddenGuard,
  withPolicyGuard,
  withRuleGuard,
  type CommandIO,
} from './adapter.ts'
import {
  runWithAdmission,
  runWithMountGate,
  runWithOpPolicies,
  runWithSession,
} from '../../../context/session_context.ts'
import type { Policy } from '../../../policy/base.ts'
import { Policies } from '../../../policy/policies.ts'
import type { Action, OpsContext } from '../../../policy/types.ts'
import { Session } from '../../../workspace/session/session.ts'

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
    resourcePath: stripSlash(dir),
    virtual: dir,
    directory: dir,
    pattern,
    resolved: false,
  })
}

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
      resourcePath: 'd/a.txt',
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
      resourcePath: 'd/a.txt',
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

describe('withRuleGuard', () => {
  const spec = (virtual: string): PathSpec =>
    new PathSpec({
      virtual,
      directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
      resourcePath: virtual,
      resolved: true,
    })

  it('asks the bound gate and leaves stat alone', async () => {
    const calls: string[][] = []
    async function* stream(_a: Accessor, path: PathSpec): AsyncGenerator<Uint8Array> {
      calls.push(['stream', path.virtual])
      yield await Promise.resolve(new Uint8Array([1]))
    }
    const ops: CommandIO = {
      readdir: (_a, path) => {
        calls.push(['readdir', path.virtual])
        return Promise.resolve(['/data/locked/y'])
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
      rename: (_a, src, dst) => {
        calls.push(['rename', src.virtual, dst.virtual])
        return Promise.resolve()
      },
    }
    const guarded = withRuleGuard(ops)
    // No gate bound: every slot runs as is.
    expect(await guarded.readBytes(accessor, spec('/data/locked/y'))).toEqual(new Uint8Array([1]))
    const asked: string[] = []
    const gate = {
      scoped: true,
      granted: [],
      check: (virtual: string) => {
        asked.push(virtual)
        if (virtual === '/data/locked/y') throw new Error(`refused ${virtual}`)
      },
    }
    await runWithAdmission(gate, async () => {
      // The gate throws at call time, like the hidden guard, so a caller's
      // `await` inside a try sees it the same way as a rejection.
      expect(() => guarded.readBytes(accessor, spec('/data/locked/y'))).toThrow('refused')
      // stat is not a guarded slot: deny is present and refused.
      expect((await guarded.stat(accessor, spec('/data/locked/y'))).size).toBe(1)
      // readdir asks about the directory, never filters its names.
      expect(await guarded.readdir(accessor, spec('/data/locked'))).toEqual(['/data/locked/y'])
      // A pair op asks about both paths.
      const rename = guarded.rename
      if (rename === undefined) throw new Error('rename slot missing')
      expect(() => rename(accessor, spec('/data/a'), spec('/data/locked/y'))).toThrow('refused')
      await rename(accessor, spec('/data/a'), spec('/data/b'))
    })
    expect(asked).toEqual([
      '/data/locked/y',
      '/data/locked',
      '/data/a',
      '/data/locked/y',
      '/data/a',
      '/data/b',
    ])
    expect(calls).not.toContainEqual(['rename', '/data/a', '/data/locked/y'])
    expect(calls).toContainEqual(['rename', '/data/a', '/data/b'])
  })
})

/** Refuse reads of one path; record every op asked. */
class SealedRead implements Policy {
  readonly asked: [string, string, boolean][] = []
  private readonly sealed: string
  constructor(sealed: string) {
    this.sealed = sealed
  }
  preOps(ctx: OpsContext): Action | null {
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
      resourcePath: virtual,
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
        await expect(ops.readBytes(accessor, spec('/data/secret'))).rejects.toThrow('sealed')
        expect(calls).not.toContainEqual(['read', '/data/secret'])
        // The stream gates before its first chunk.
        await expect(drain(ops.readStream(accessor, spec('/data/secret')))).rejects.toThrow(
          'sealed',
        )
        expect(calls).not.toContainEqual(['stream', '/data/secret'])
        // stat is not a guarded slot: deny is present and refused.
        expect((await ops.stat(accessor, spec('/data/secret'))).size).toBe(1)
        // readdir asks about the directory it lists.
        expect(await ops.readdir(accessor, spec('/data/dir'))).toEqual(['a'])
        // A copy's source is a read; its destination is a write.
        const copy = ops.copy
        if (copy === undefined) throw new Error('copy slot missing')
        await copy(accessor, spec('/data/src'), spec('/data/dst'))
        // A write slot asks with write=true.
        const unlink = ops.unlink
        if (unlink === undefined) throw new Error('unlink slot missing')
        await unlink(accessor, spec('/data/gone'))
      }),
    )
    expect(policy.asked).toContainEqual(['read_bytes', '/data/secret', false])
    expect(policy.asked).toContainEqual(['read_stream', '/data/secret', false])
    expect(policy.asked).toContainEqual(['readdir', '/data/dir', false])
    expect(policy.asked).toContainEqual(['copy', '/data/src', false])
    expect(policy.asked).toContainEqual(['copy', '/data/dst', true])
    expect(policy.asked).toContainEqual(['unlink', '/data/gone', true])
    expect(policy.asked.some(([op]) => op === 'stat')).toBe(false)
  })

  it('wrap-time capture covers late drains', async () => {
    // head/tail/wc bind lazy readers the pipeline drains after dispatch
    // has reset the context; the guard captured at wrap time still
    // answers (livePolicyScope).
    const calls: string[][] = []
    const raw = probeOps(calls)
    const policy = new SealedRead('/data/secret')
    const ops = await runWithOpPolicies(new Policies([policy]), () =>
      Promise.resolve(withPolicyGuard(raw)),
    )
    // Both the slot call and the drain happen outside the window now.
    await expect(drain(ops.readStream(accessor, spec('/data/secret')))).rejects.toThrow('sealed')
    expect(calls).not.toContainEqual(['stream', '/data/secret'])
    await expect(ops.readBytes(accessor, spec('/data/secret'))).rejects.toThrow('sealed')
  })

  it('admits before a warm serve', async () => {
    // The guard wraps outside the cache tier (`finish` in the factory),
    // so a warm reader below it never answers a refused read.
    const calls: string[][] = []
    const warm: CommandIO = {
      ...probeOps(calls),
      readBytes: () => Promise.resolve(new TextEncoder().encode('warm')),
    }
    const policy = new SealedRead('/data/secret')
    await runWithOpPolicies(new Policies([policy]), async () => {
      const ops = withPolicyGuard(warm)
      await expect(ops.readBytes(accessor, spec('/data/secret'))).rejects.toThrow('sealed')
      expect(await ops.readBytes(accessor, spec('/data/open'))).toEqual(
        new TextEncoder().encode('warm'),
      )
    })
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

describe('withHiddenGuard rmdir under namespace children', () => {
  it('a visible mounted child keeps the rmdir refusal', async () => {
    // The guard is applied over an adapter already stamped with the
    // invocation's globChildren (the factory's per-invocation order),
    // so the visible mounted child joins the emptiness judgment and
    // the not-empty refusal stays with the cascade never started.
    const removed: string[] = []
    const notEmpty = (): Error => {
      const err = new Error('ENOTEMPTY: directory not empty') as Error & { code: string }
      err.code = 'ENOTEMPTY'
      return err
    }
    const base: CommandIO = {
      readdir: () => Promise.resolve(['h']),
      readBytes: () => Promise.reject(new Error('not used')),
      readStream: () => {
        throw new Error('not used')
      },
      stat: (_a, path) =>
        Promise.resolve(
          new FileStat({ name: path.virtual, type: FileType.FILE, content: ContentType.TEXT }),
        ),
      isMounted: () => true,
      unlink: (_a, path) => {
        removed.push(path.virtual)
        return Promise.resolve()
      },
      rmdir: () => Promise.reject(notEmpty()),
      globChildren: (parent: string) => (parent === '/m/d' ? ['m'] : []),
    }
    const ops = withHiddenGuard(base)
    const rmdir = ops.rmdir
    if (rmdir === undefined) throw new Error('rmdir slot missing')
    const sess = new Session({ sessionId: 'narrowed' })
    sess.hiddenPaths = { paths: ['/m/d/h'] }
    const spec = new PathSpec({ virtual: '/m/d', directory: '/m', resourcePath: 'd' })
    await runWithSession(sess, async () => {
      await expect(rmdir(accessor, spec)).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    })
    expect(removed).toEqual([])
  })

  it('a failed fallback listing keeps the rmdir refusal', async () => {
    // A backend that cannot list the remnants keeps the original
    // refusal, whatever error type it failed with: a raw backend
    // failure here would reveal exactly what the refusal exists to
    // hide.
    const notEmpty = (): Error => {
      const err = new Error('ENOTEMPTY: directory not empty') as Error & { code: string }
      err.code = 'ENOTEMPTY'
      return err
    }
    const base: CommandIO = {
      readdir: () => Promise.reject(new Error('api exploded')),
      readBytes: () => Promise.reject(new Error('not used')),
      readStream: () => {
        throw new Error('not used')
      },
      stat: (_a, path) =>
        Promise.resolve(
          new FileStat({ name: path.virtual, type: FileType.FILE, content: ContentType.TEXT }),
        ),
      isMounted: () => true,
      unlink: () => Promise.reject(new Error('never reached')),
      rmdir: () => Promise.reject(notEmpty()),
    }
    const ops = withHiddenGuard(base)
    const rmdir = ops.rmdir
    if (rmdir === undefined) throw new Error('rmdir slot missing')
    const sess = new Session({ sessionId: 'narrowed' })
    sess.hiddenPaths = { paths: ['/m/d/h'] }
    const spec = new PathSpec({ virtual: '/m/d', directory: '/m', resourcePath: 'd' })
    await runWithSession(sess, async () => {
      await expect(rmdir(accessor, spec)).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    })
  })
})
