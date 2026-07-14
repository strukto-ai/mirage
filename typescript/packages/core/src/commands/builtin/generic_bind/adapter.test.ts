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
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { enoent } from '../../../utils/errors.ts'
import { dirAwareStat, dirAwareStream, makeResolveGlob, type CommandIO } from './adapter.ts'

const accessor = {} as never

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
      return Promise.resolve(new FileStat({ name: p.virtual, size: 0 }))
    },
    isMounted: () => true,
  }
}

describe('dirAwareStat', () => {
  it('refuses an implicit keyed-backend directory with EISDIR', async () => {
    const stat = dirAwareStat(dirOps(['/sub']), accessor)
    await expect(stat(PathSpec.fromStrPath('/sub'))).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('refuses a stat-typed directory with EISDIR', async () => {
    const stat = dirAwareStat(dirOps([], ['/sub']), accessor)
    await expect(stat(PathSpec.fromStrPath('/sub'))).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('keeps ENOENT for a genuinely missing path', async () => {
    const failing: CommandIO = { ...dirOps([]), stat: (_a, p) => Promise.reject(enoent(p)) }
    const stat = dirAwareStat(failing, accessor)
    await expect(stat(PathSpec.fromStrPath('/nope.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
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
    const stat = dirAwareStat(lying, accessor)
    await expect(stat(PathSpec.fromStrPath('/nope.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps ENOENT when the probe readdir raises a driver error', async () => {
    const throwing: CommandIO = {
      ...dirOps([]),
      stat: (_a, p) => Promise.reject(enoent(p)),
      readdir: () => Promise.reject(new Error("Table 'nope.txt' was not found")),
    }
    const stat = dirAwareStat(throwing, accessor)
    await expect(stat(PathSpec.fromStrPath('/nope.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('passes regular files through', async () => {
    const stat = dirAwareStat(dirOps([]), accessor)
    await expect(stat(PathSpec.fromStrPath('/f.txt'))).resolves.toMatchObject({ size: 0 })
  })
})

describe('dirAwareStream', () => {
  it('refuses an implicit directory with EISDIR when consumed', async () => {
    const stream = dirAwareStream(dirOps(['/sub']), accessor)
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
    const stream = dirAwareStream(sshLike, accessor)
    const consume = async () => {
      for await (const chunk of stream(PathSpec.fromStrPath('/sub'))) {
        throw new Error(`no data expected, got ${String(chunk.byteLength)} bytes`)
      }
    }
    await expect(consume()).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('streams regular files untouched', async () => {
    const stream = dirAwareStream(dirOps([]), accessor)
    const chunks: Uint8Array[] = []
    for await (const chunk of stream(PathSpec.fromStrPath('/f.txt'))) chunks.push(chunk)
    expect(new TextDecoder().decode(chunks[0])).toBe('data')
  })
})
