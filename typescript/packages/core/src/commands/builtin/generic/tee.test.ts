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
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { eacces, enoent } from '../../../utils/errors.ts'
import { parseFlags, writeOutput } from './tee.ts'

const DEC = new TextDecoder()

describe('parseFlags', () => {
  // Only the exit/warn axis is observable: the -nopipe half tells a pipe
  // sink from a file sink, and every operand tee writes is a file. A bare
  // --output-error means warn (GNU 9.7).
  it.each([
    ['warn-nopipe', false],
    ['exit', true],
    [true, false],
  ] as const)('reads --output-error=%j', (mode, stop) => {
    expect(parseFlags({ output_error: mode })).toEqual({ append: false, stopOnError: stop })
  })
})

describe('writeOutput', () => {
  const ENC = new TextEncoder()
  const paths = (...names: string[]): PathSpec[] => names.map((n) => PathSpec.fromStrPath(n))
  const PLAIN = { append: false, stopOnError: false }
  const APPEND = { append: true, stopOnError: false }
  const noStream = (): AsyncIterable<Uint8Array> => {
    throw enoent('/unused')
  }

  function sink(fail = new Set<string>()): {
    written: Record<string, string>
    write: (p: PathSpec, d: Uint8Array) => Promise<void>
  } {
    const written: Record<string, string> = {}
    return {
      written,
      write: (p, d) => {
        if (fail.has(p.mountPath)) return Promise.reject(new Error('disk full'))
        written[p.mountPath] = DEC.decode(d)
        return Promise.resolve()
      },
    }
  }

  it('writes every operand, not just the first', async () => {
    // GNU 9.7: `printf x | tee a b c` puts x in all three. Both generics
    // used to write paths[0] and silently drop the rest, while the spec
    // declared a variadic rest operand.
    const s = sink()
    const [out, io] = await writeOutput(
      paths('/a', '/b', '/c'),
      ENC.encode('hi'),
      PLAIN,
      noStream,
      s.write,
    )
    expect(s.written).toEqual({ '/a': 'hi', '/b': 'hi', '/c': 'hi' })
    expect(DEC.decode(out as Uint8Array)).toBe('hi')
    expect(io.exitCode).toBe(0)
    expect(io.cache).toEqual(['/a', '/b', '/c'])
  })

  it('keeps writing the others when one operand fails', async () => {
    // GNU pins: `tee p bad q` writes p and q, diagnoses bad, exits 1.
    const s = sink(new Set(['/bad']))
    const [out, io] = await writeOutput(
      paths('/p', '/bad', '/q'),
      ENC.encode('x'),
      PLAIN,
      noStream,
      s.write,
    )
    expect(s.written).toEqual({ '/p': 'x', '/q': 'x' })
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('tee: /bad: disk full\n')
    expect(DEC.decode(out as Uint8Array)).toBe('x')
  })

  it('stops at the first failure under --output-error=exit', async () => {
    const s = sink(new Set(['/bad']))
    const [, io] = await writeOutput(
      paths('/p', '/bad', '/q'),
      ENC.encode('x'),
      { append: false, stopOnError: true },
      noStream,
      s.write,
    )
    expect(s.written).toEqual({ '/p': 'x' })
    expect(io.exitCode).toBe(1)
  })

  it('reports the output that fails while being emptied, keeping the records', async () => {
    const s = sink(new Set(['/denied']))
    const stat = (p: PathSpec): Promise<FileStat> =>
      Promise.resolve(
        new FileStat({
          name: p.virtual.slice(1),
          type: p.virtual === '/dir' ? FileType.DIRECTORY : FileType.FILE,
        }),
      )
    const [out, io] = await writeOutput(
      paths('/good', '/denied', '/dir'),
      ENC.encode('x'),
      { append: false, stopOnError: true },
      noStream,
      s.write,
      undefined,
      stat,
    )
    expect(out).toBeNull()
    expect(s.written).toEqual({ '/good': '' })
    expect([Object.keys(io.writes), io.cache]).toEqual([['/good'], ['/good']])
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('tee: /denied: disk full\n')
  })

  it('leaves the open to the write when the probe is refused', async () => {
    const s = sink()
    const stat = (p: PathSpec): Promise<FileStat> =>
      p.virtual === '/locked'
        ? Promise.reject(eacces(p))
        : Promise.resolve(new FileStat({ name: p.virtual.slice(1), type: FileType.FILE }))
    const [out, io] = await writeOutput(
      paths('/good', '/locked'),
      ENC.encode('x'),
      { append: false, stopOnError: true },
      noStream,
      s.write,
      undefined,
      stat,
    )
    expect(out).not.toBeNull()
    expect(s.written).toEqual({ '/good': 'x', '/locked': 'x' })
    expect(io.exitCode).toBe(0)
  })

  it.each([
    [['/good', '/locked'], false, ['/locked'], { '/good': '' }, 'tee: /locked: disk full\n'],
    [
      ['/locked', '/gone/x'],
      true,
      [],
      { '/locked': '' },
      'tee: /gone/x: No such file or directory\n',
    ],
    [['/bad', '/locked'], false, ['/bad'], {}, 'tee: /bad: disk full\n'],
  ] as const)(
    'opens an unprobed output in order before any data: %o',
    async (outputs, append, refused, written, stderr) => {
      const s = sink(new Set(refused))
      const stat = (p: PathSpec): Promise<FileStat> => {
        if (p.virtual === '/locked') return Promise.reject(eacces(p))
        if (p.virtual.startsWith('/gone')) return Promise.reject(enoent(p))
        return Promise.resolve(new FileStat({ name: p.virtual.slice(1), type: FileType.FILE }))
      }
      const [out, io] = await writeOutput(
        paths(...outputs),
        ENC.encode('x'),
        { append, stopOnError: true },
        noStream,
        s.write,
        undefined,
        stat,
      )
      expect(out).toBeNull()
      expect(s.written).toEqual(written)
      expect(io.exitCode).toBe(1)
      expect(DEC.decode(io.stderr as Uint8Array)).toBe(stderr)
    },
  )

  it('diagnoses every failing operand', async () => {
    const s = sink(new Set(['/b1', '/b2']))
    const [, io] = await writeOutput(paths('/b1', '/b2'), ENC.encode('x'), PLAIN, noStream, s.write)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('tee: /b1: disk full\ntee: /b2: disk full\n')
    expect(io.exitCode).toBe(1)
  })

  it('appends through the native slot without re-uploading', async () => {
    const appended: Record<string, string> = {}
    const s = sink()
    const [, io] = await writeOutput(
      paths('/n'),
      ENC.encode('add'),
      APPEND,
      noStream,
      s.write,
      (p, d) => {
        appended[p.mountPath] = DEC.decode(d)
        return Promise.resolve()
      },
    )
    expect(appended).toEqual({ '/n': 'add' })
    expect(s.written).toEqual({})
    // Listed as written but not as cacheable: the resulting content is not
    // in hand, so the stale cache entry must be dropped, not replaced.
    expect(Object.keys(io.writes)).toEqual(['/n'])
    expect(io.cache).toEqual([])
  })

  it('falls back to read-modify-write when the backend has no append', async () => {
    const s = sink()
    const [, io] = await writeOutput(
      paths('/n'),
      ENC.encode('add'),
      APPEND,
      () =>
        (async function* () {
          await Promise.resolve()
          yield ENC.encode('old')
        })(),
      s.write,
    )
    expect(s.written).toEqual({ '/n': 'oldadd' })
    expect(io.cache).toEqual(['/n'])
  })
})
