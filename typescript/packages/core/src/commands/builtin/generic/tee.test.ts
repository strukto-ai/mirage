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
import { eacces, enoent } from '../../../errors/fs.ts'
import { materialize } from '../../../io/types.ts'
import type { CommandOpts } from '../../config.ts'
import { PipeErrors, parseFlags, teeGeneric, writeOutput } from './tee.ts'

const DEC = new TextDecoder()

describe('parseFlags', () => {
  // -p and a bare --output-error are warn-nopipe. The -nopipe half leaves a
  // pipe whose reader has gone unreported, and with neither option a write
  // into one is SIGPIPE.
  it.each([
    [{}, false, PipeErrors.SIGNAL],
    [{ p: true }, false, PipeErrors.IGNORE],
    [{ output_error: true }, false, PipeErrors.IGNORE],
    [{ output_error: 'warn' }, false, PipeErrors.REPORT],
    [{ output_error: 'warn-nopipe' }, false, PipeErrors.IGNORE],
    [{ output_error: 'exit' }, true, PipeErrors.REPORT],
    [{ output_error: 'exit-nopipe' }, true, PipeErrors.IGNORE],
  ] as const)('reads %j', (flags, stop, pipeErrors) => {
    expect(parseFlags(flags)).toEqual({ append: false, stopOnError: stop, pipeErrors })
  })
})

describe('writeOutput', () => {
  const ENC = new TextEncoder()
  const paths = (...names: string[]): PathSpec[] => names.map((n) => PathSpec.fromStrPath(n))
  const PLAIN = { append: false, stopOnError: false, pipeErrors: PipeErrors.SIGNAL }
  const APPEND = { append: true, stopOnError: false, pipeErrors: PipeErrors.SIGNAL }
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
      { append: false, stopOnError: true, pipeErrors: PipeErrors.REPORT },
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
      { append: false, stopOnError: true, pipeErrors: PipeErrors.REPORT },
      noStream,
      s.write,
      undefined,
      stat,
    )
    expect(out).toBeNull()
    expect(s.written).toEqual({ '/good': '' })
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
      { append: false, stopOnError: true, pipeErrors: PipeErrors.REPORT },
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
        { append, stopOnError: true, pipeErrors: PipeErrors.REPORT },
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
    await writeOutput(paths('/n'), ENC.encode('add'), APPEND, noStream, s.write, (p, d) => {
      appended[p.mountPath] = DEC.decode(d)
      return Promise.resolve()
    })
    expect(appended).toEqual({ '/n': 'add' })
    expect(s.written).toEqual({})
  })

  it('falls back to read-modify-write when the backend has no append', async () => {
    const s = sink()
    await writeOutput(
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
  })
})

describe('teeGeneric', () => {
  it('ends under exit on a refused open while its input is quiet', async () => {
    let closed = false
    const quiet: AsyncIterableIterator<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return this
      },
      next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
      return() {
        closed = true
        return Promise.resolve({ done: true, value: undefined })
      },
    }
    const result = await teeGeneric(
      [PathSpec.fromStrPath('/locked')],
      [],
      {
        stdin: quiet,
        flags: { output_error: 'exit' },
        cwd: '/',
        vfs: {},
      } as unknown as CommandOpts,
      () => {
        throw enoent('/unused')
      },
      (p) => Promise.reject(eacces(p)),
      undefined,
      (p) => Promise.resolve(new FileStat({ name: p.virtual.slice(1), type: FileType.FILE })),
    )
    const [out, io] = result ?? [null, null]
    expect(DEC.decode(await materialize(out))).toBe('')
    expect(io?.exitCode).toBe(1)
    expect(DEC.decode(io?.stderr as Uint8Array)).toBe('tee: /locked: Permission denied\n')
    expect(closed).toBe(true)
  })
})
