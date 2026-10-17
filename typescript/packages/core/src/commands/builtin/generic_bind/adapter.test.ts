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
import {
  runWithAdmission,
  runWithMountGate,
  runWithSession,
} from '../../../context/session_context.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { requireOp, withAbortGuard } from './adapter.ts'
import { ContentType, FileStat, FileType, MountMode, PathSpec } from '../../../types.ts'
import { eacces, eisdir, enoent } from '../../../errors/fs.ts'
import { formatFsError } from '../../../errors/render.ts'
import { IOResult } from '../../../io/types.ts'
import { Files } from '../../../workspace/files.ts'
import { stripSlash } from '../../../utils/slash.ts'
import { SessionState } from '../../../workspace/session/session.ts'
import type { Context, CommandIO } from '../../config.ts'
import {
  commandIo,
  dirAwareStat,
  dirAwareStream,
  fileSize,
  resolveGlobOf,
  withDirGuard,
} from './adapter.ts'
import { runWithRevisions } from '../../../observe/context.ts'
import { BaseVFS } from '../../../vfs/base.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { makeResolveGlob } from '../../../utils/glob_walk.ts'
import { BatchedRAM } from '../../../test-utils.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'

const accessor = {} as never
// No namespace facts, which is what a command bound outside a workspace
// gets: the two probes below the backend are the only ones that can fire.
const NO_NS = {} as Context
// The one a mount parent needs: no backend row, a name plane that owes the
// path a child name: a mount below it.
function nsDir(dir: string): Context {
  const nothing: DispatchFn = () => Promise.resolve([null, new IOResult()])
  return {
    vfs: new Files(nothing, null, null, () => null, { prefixes: () => [`${dir}/alpha/`] }),
  } as Context
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
  it('lets a trailing slash follow a link through the target stat', async () => {
    // The factory stamps the invocation's link target stat; the resolver
    // drops a link to nothing the way bash does and keeps a link to a
    // directory.
    const readdir = () => Promise.resolve(['/d/alpha', '/d/broken', '/d/lnk'])
    const stat = (_a: unknown, p: PathSpec) =>
      Promise.resolve(
        p.virtual === '/d/alpha'
          ? new FileStat({ name: 'alpha', type: FileType.DIRECTORY })
          : new FileStat({ name: p.virtual.split('/').pop() ?? '', type: FileType.SYMLINK }),
      )
    const ops: CommandIO = {
      readdir,
      readBytes: () => Promise.resolve(new Uint8Array()),
      readStream: () => oneChunkStream(new Uint8Array()),
      stat,
      isMounted: () => true,
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

  it('lets a refused listing through the implicit-directory probe', async () => {
    // Only a miss is a negative probe here: the stat is the operation, so a
    // parent listing the session may not read fails it as itself.
    const refused: CommandIO = {
      ...dirOps([]),
      stat: (_a, p) => Promise.reject(enoent(p)),
      readdir: (_a, p) => Promise.reject(eacces(p.virtual)),
    }
    const stat = dirAwareStat(refused, accessor, NO_NS)
    await expect(stat(PathSpec.fromStrPath('/locked/nope.txt'))).rejects.toMatchObject({
      code: 'EACCES',
    })
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

function keyedReadOps(ctx: {
  implicitDirs?: readonly string[]
  explicitDirs?: readonly string[]
  files?: Record<string, string>
  readError?: (p: PathSpec) => Error
}): CommandIO {
  const implicitDirs = ctx.implicitDirs ?? []
  const explicitDirs = ctx.explicitDirs ?? []
  const files = ctx.files ?? {}
  const readError = ctx.readError ?? ((p: PathSpec) => enoent(p))
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
      readTree: (_a, path) => {
        calls.push(`readTree ${path.virtual}`)
        return Promise.resolve(null)
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
    await expect(guarded.readTree?.(accessor, spec('/data'))).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(calls).toEqual([])
  })

  // A pushed-down `wc -l` over two tables would otherwise start the
  // second count after the caller was released.
  it('refuses the line answers too', async () => {
    const calls: string[] = []
    const controller = new AbortController()
    const guarded = withAbortGuard(
      {
        ...recording(calls),
        firstLines: (_a, path) => {
          calls.push(`firstLines ${path.virtual}`)
          return Promise.resolve(null)
        },
        lastLines: (_a, path) => {
          calls.push(`lastLines ${path.virtual}`)
          return Promise.resolve(null)
        },
        lineCount: (_a, path) => {
          calls.push(`lineCount ${path.virtual}`)
          return Promise.resolve(null)
        },
        follow: (_a, path) => {
          calls.push(`follow ${path.virtual}`)
          return Promise.resolve(null)
        },
      },
      controller.signal,
    )
    controller.abort(new Error('released'))
    const aborted = { name: 'AbortError' }
    await expect(guarded.firstLines?.(accessor, spec('/t'), 1)).rejects.toMatchObject(aborted)
    await expect(guarded.lastLines?.(accessor, spec('/t'), 1)).rejects.toMatchObject(aborted)
    await expect(guarded.lineCount?.(accessor, spec('/t'))).rejects.toMatchObject(aborted)
    await expect(guarded.follow?.(accessor, spec('/t'), 1, 1)).rejects.toMatchObject(aborted)
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
// judges it itself; the guards hold a missing one.
const capabilityCases = [
  ...(['write', 'mkdir', 'unlink', 'rename', 'copy', 'truncate'] as const).map((operation) => ({
    available: false,
    operation,
  })),
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
        const ops = capabilityOps(available ? backend : undefined)
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
        const ops = table
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

describe('fileSize', () => {
  const sized = (st: FileStat): CommandIO => ({ ...dirOps([]), stat: () => Promise.resolve(st) })

  // Mirrors python's test_file_size_answers_only_a_store_without_permission_bits.
  it.each([
    [new FileStat({ name: 'f', type: FileType.FILE, size: 7 }), 7],
    [new FileStat({ name: 'f', type: FileType.FILE, size: 7, mode: 0o644 }), null],
    [new FileStat({ name: 'f', type: FileType.FILE }), null],
    [new FileStat({ name: 'f', type: FileType.CHAR_DEVICE, size: 0 }), null],
  ])('answers %j as %s', async (st, size) => {
    expect(await fileSize(sized(st), accessor, NO_NS)(PathSpec.fromStrPath('/f'))).toBe(size)
  })

  // Mirrors python's test_file_size_reads_a_file_whose_size_moved_since_its_listing.
  it.each([
    [7, 7],
    [9, null],
  ])('answers a fresh size of %s as %s', async (now, size) => {
    const asked: unknown[] = []
    const dispatch: DispatchFn = (name, _path, _args, kwargs) => {
      asked.push([name, kwargs])
      return Promise.resolve([
        new FileStat({ name: 'f', type: FileType.FILE, size: now }),
        new IOResult(),
      ])
    }
    const bound = fileSize(
      sized(new FileStat({ name: 'f', type: FileType.FILE, size: 7 })),
      accessor,
      { ...NO_NS, dispatch },
    )
    expect(await bound(PathSpec.fromStrPath('/f'))).toBe(size)
    expect(asked).toEqual([['stat', { fresh: true }]])
  })

  // Mirrors python's test_file_size_reads_a_path_pinned_to_a_revision.
  it('reads a path pinned to a revision', async () => {
    const bound = fileSize(
      sized(new FileStat({ name: 'f', type: FileType.FILE, size: 7 })),
      accessor,
      NO_NS,
    )
    const found = await runWithRevisions(new Map([['/f', 'v1']]), () =>
      bound(PathSpec.fromStrPath('/f')),
    )
    expect(found).toBeNull()
  })
})

// Twin of test_a_glob_read_warms_the_operands_after_it.
it('warms the operands after a glob read', async () => {
  const vfs = new BatchedRAM()
  const names = Array.from({ length: 12 }, (_, i) => `/f${String(i).padStart(2, '0')}`)
  for (const name of names) vfs.store.files.set(name, new TextEncoder().encode('x\n'))
  const parser = await getTestParser()
  const ws = new Workspace({ '/r': vfs }, { shellParserFactory: () => Promise.resolve(parser) })
  try {
    const out = await ws.shell('cat /r/f*')
    expect(new TextDecoder().decode(out.stdout)).toBe('x\n'.repeat(12))
  } finally {
    await ws.close()
  }
  const warmed = names.slice(1).map((name) => `/r${name}`)
  expect(vfs.reads).toEqual(['/r/f00'])
  expect(vfs.batches).toEqual([warmed.slice(0, 8), warmed.slice(8)])
})
