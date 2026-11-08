import { describe, expect, it } from 'vitest'
import { yieldBytes } from '../../../io/stream.ts'
import { materialize, type ByteSource } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { gzip } from '../../../utils/compress.ts'
import { eisdir, enoent } from '../../../errors/fs.ts'
import { decompressInputs, gzipRatio, gzipSuffix, listInputs, suffixRefusal } from './decompress.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()
const HELLO = await gzip(enc.encode('hello'))

function cat(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(parts.flatMap((p) => [...p]))
}

function backend(files: Map<string, Uint8Array>) {
  const reads: string[] = []
  async function* read(path: PathSpec): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    reads.push(path.virtual)
    if (path.virtual.endsWith('/dir')) throw eisdir(path)
    const data = files.get(path.virtual)
    if (data === undefined) throw enoent(path)
    yield* yieldBytes(data)
  }
  return {
    reads,
    read,
    options: {
      write: async (path: PathSpec, data: ByteSource) => {
        files.set(path.virtual, await materialize(data))
      },
      unlink: (path: PathSpec) => {
        files.delete(path.virtual)
        return Promise.resolve()
      },
      stat: (path: PathSpec) => {
        if (!files.has(path.virtual)) return Promise.reject(enoent(path))
        return Promise.resolve(new FileStat({ name: path.virtual, type: FileType.FILE }))
      },
    },
  }
}

function typed(virtual: string, rawPath: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/') + 1),
    vfsPath: virtual.replace(/^\/+/, ''),
    rawPath,
  })
}

// A buffered run's stderr is whole bytes by the time it is read.
function text(bytes: ByteSource | null): string | null {
  return bytes === null ? null : dec.decode(bytes as Uint8Array)
}

it.each([null, 'x', '\x1f'])('stops after fatal input: %j', async (suffix) => {
  const reads: string[] = []
  async function* read(path: PathSpec): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    reads.push(path.virtual)
    yield suffix === null ? new Uint8Array() : cat(HELLO, enc.encode(suffix))
  }
  async function* stdin(): AsyncIterable<Uint8Array> {
    reads.push('stdin')
    yield await gzip(enc.encode('hello'))
  }
  const paths = ['/a/bad.gz', '/b/missing.gz', '-'].map((p) => PathSpec.fromStrPath(p))
  const [body, io] = await decompressInputs(paths, read, { stdin: stdin(), toStdout: true })
  expect(await materialize(body)).toEqual(enc.encode(suffix === null ? '' : 'hello'))
  expect(reads).toEqual(['/a/bad.gz'])
  expect(io.exitCode).toBe(1)
  expect(text(io.stderr)).toBe('\ngzip: /a/bad.gz: unexpected end of file\n')
})

describe('the names gzip opens', () => {
  // gzip 1.13 opens the name, then the name with each suffix, and names the
  // -S one when every open misses.
  it.each([
    ['.gz', ['/d/x', '/d/x.gz', '/d/x.z', '/d/x-z', '/d/x.Z'], 'x.gz'],
    ['.y', ['/d/x', '/d/x.y', '/d/x.gz', '/d/x.z', '/d/x-z', '/d/x.Z'], 'x.y'],
  ])('retries a missing name with each suffix under -S %s', async (suffix, tried, shown) => {
    const { reads, read, options } = backend(new Map())
    const [body, io] = await decompressInputs([typed('/d/x', 'x')], read, {
      stdin: null,
      toStdout: true,
      suffix,
      ...options,
    })
    expect(await materialize(body)).toEqual(new Uint8Array())
    expect(reads).toEqual(tried)
    expect([io.exitCode, text(io.stderr)]).toEqual([
      1,
      `gzip: ${shown}: No such file or directory\n`,
    ])
  })

  it('does not retry a name with a known suffix', async () => {
    const { reads, read, options } = backend(new Map())
    const [, io] = await decompressInputs([typed('/d/x.GZ', 'x.GZ')], read, {
      stdin: null,
      ...options,
    })
    expect(reads).toEqual(['/d/x.GZ'])
    expect(text(io.stderr)).toBe('gzip: x.GZ: No such file or directory\n')
  })

  it('tries the suffixes themselves for the empty name', async () => {
    const reads: string[] = []
    // eslint-disable-next-line require-yield
    async function* read(path: PathSpec): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      reads.push(path.rawPath)
      throw enoent(path)
    }
    const empty = new PathSpec({
      virtual: '/d',
      directory: '/',
      vfsPath: 'd',
      rawPath: '',
      walkError: 'ENOENT',
    })
    const [, io] = await decompressInputs([empty], read, {
      stdin: null,
      ...backend(new Map()).options,
    })
    expect(reads).toEqual(['', '.gz', '.z', '-z', '.Z'])
    expect(text(io.stderr)).toBe('gzip: .gz: No such file or directory\n')
  })
})

describe('to stdout', () => {
  it('silences a directory warning under quiet but keeps exit 2', async () => {
    const { read, options } = backend(new Map())
    const [body, io] = await decompressInputs([PathSpec.fromStrPath('/d/dir')], read, {
      stdin: null,
      toStdout: true,
      quiet: true,
      ...options,
    })
    expect(await materialize(body)).toEqual(new Uint8Array())
    expect([text(io.stderr), io.exitCode]).toEqual([null, 2])
  })

  it.each([
    ['one byte', enc.encode('\x1f'), '\x1f'],
    ['trailing zeros', cat(HELLO, new Uint8Array(2)), 'hello\0\0'],
  ])('copies what is not gzip under -f: %s', async (_name, data, out) => {
    const { read, options } = backend(new Map([['/d/f', data]]))
    const [body, io] = await decompressInputs([PathSpec.fromStrPath('/d/f')], read, {
      stdin: null,
      toStdout: true,
      force: true,
      ...options,
    })
    expect([dec.decode(await materialize(body)), io.exitCode, text(io.stderr)]).toEqual([
      out,
      0,
      null,
    ])
  })
})

it.each(['', '.' + 'a'.repeat(30)])('refuses the -S suffix %j before any input', async (suffix) => {
  const { reads, read, options } = backend(new Map([['/d/x.gz', HELLO]]))
  const [, io] = await decompressInputs([PathSpec.fromStrPath('/d/x.gz')], read, {
    stdin: null,
    suffix,
    ...options,
  })
  expect(reads).toEqual([])
  expect([io.exitCode, text(io.stderr)]).toEqual([1, `gzip: invalid suffix '${suffix}'\n`])
})

it.each([
  ['a.GZ', '.gz', '.GZ'],
  ['a.Tgz', '.gz', '.Tgz'],
  ['a_z', '.gz', '_z'],
  ['.gz', '.gz', null],
  ['a.xy', '.XY', '.xy'],
])('reads the suffix of %s under -S %s as %s', (name, suffix, found) => {
  expect(gzipSuffix(name, suffix)).toBe(found)
})

it.each([
  ['.' + 'a'.repeat(29), false],
  ['.' + 'a'.repeat(30), true],
])('takes a -S suffix of one to thirty bytes: %j', (suffix, refused) => {
  expect(suffixRefusal(suffix) !== null).toBe(refused)
})

it.each([
  [18, 41, 24, '  5.6%'],
  [400, 351, 0, ' 12.2%'],
  [400, 349, 0, ' 12.8%'],
  [0, 22, 20, '  0.0%'],
  [1, 23, 20, '-200.0%'],
])('the ratio rounds a tie to even as printf does: %i %i %i', (size, compressed, header, shown) => {
  expect(gzipRatio(size, compressed, header)).toBe(shown)
})

it('a listing totals only once a row was printed', async () => {
  const { read, options } = backend(
    new Map([
      ['/d/a.gz', HELLO],
      ['/d/bad.gz', enc.encode('junk')],
    ]),
  )
  const bad = PathSpec.fromStrPath('/d/bad.gz')
  let [out, io] = await listInputs([bad, bad], read, { stdin: null, stat: options.stat })
  expect([text(out), io.exitCode]).toEqual(['', 1])
  ;[out, io] = await listInputs([PathSpec.fromStrPath('/d/a.gz'), bad], read, {
    stdin: null,
    stat: options.stat,
  })
  const rows = (text(out) ?? '').split('\n')
  expect(rows[1]?.split(/ +/).filter(Boolean)).toEqual(['25', '5', '-40.0%', '/d/a'])
  expect(rows[2]?.split(/ +/).filter(Boolean)).toEqual(['25', '5', '-400.0%', '(totals)'])
  expect(text(io.stderr)).toBe('\ngzip: /d/bad.gz: not in gzip format\n')
})

it('-N restores the stored name and time', async () => {
  const stored = await gzip(enc.encode('hi\n'), 'orig.txt')
  stored.set([0x44, 0x43, 0x6d, 0x38], 4)
  const { read, options } = backend(new Map([['/d/x.gz', stored]]))
  const attrs: [string, unknown][] = []
  const [, io] = await decompressInputs([PathSpec.fromStrPath('/d/x.gz')], read, {
    stdin: null,
    restore: true,
    verbose: true,
    setAttrs: (path, fields) => {
      attrs.push([path.virtual, fields])
      return Promise.resolve()
    },
    ...options,
  })
  expect(io.exitCode).toBe(0)
  expect(attrs).toEqual([['/d/orig.txt', { mtime: '1999-12-31T23:59:00Z' }]])
  expect(text(io.stderr)).toMatch(/^\/d\/x\.gz:\t.* -- replaced with \/d\/orig\.txt\n$/)
})
