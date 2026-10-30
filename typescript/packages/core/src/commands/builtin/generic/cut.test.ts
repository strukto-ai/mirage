import { expect, it } from 'vitest'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { closeQuietly } from '../../../io/stream.ts'
import type { FlagValue } from '../../spec/types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { cutConfig, cutGeneric } from './cut.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function cut(
  paths: PathSpec[],
  ctx: Context & { flags: Record<string, FlagValue> },
  stream: (path: PathSpec) => AsyncIterable<Uint8Array>,
  statFn: (path: PathSpec) => Promise<FileStat>,
): Promise<CommandFnResult> {
  const config = cutConfig(ctx.flags)
  if (config instanceof IOResult) return [null, config]
  return cutGeneric(config, paths, ctx, stream, statFn)
}

it('closes stdin when output is never started', async () => {
  let closes = 0
  const source: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return this
    },
    next() {
      return Promise.reject(new Error('input must remain unread'))
    },
    return() {
      closes++
      return Promise.resolve({ done: true, value: undefined })
    },
  }
  const result = await cut(
    [],
    { stdin: source, flags: { bytes: '1' }, cwd: PathSpec.fromStrPath('/') },
    () => source,
    stat,
  )
  if (result === null) throw new Error('cut returned no result')
  await closeQuietly(result[0])
  await closeQuietly(result[0])
  expect(closes).toBe(1)
})

function stat(path: PathSpec): Promise<FileStat> {
  if (path.virtual === '/missing') {
    return Promise.reject(Object.assign(new Error(path.virtual), { code: 'ENOENT' }))
  }
  return Promise.resolve(new FileStat({ name: path.virtual, type: FileType.FILE }))
}

it.each(['', 'first,x\n'])('reports late read errors and continues (%j)', async (prefix) => {
  const closed: string[] = []
  async function* source(path: PathSpec): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    try {
      if (path.virtual === '/denied') {
        if (prefix) yield ENC.encode(prefix)
        throw Object.assign(new Error(path.virtual), { code: 'EACCES' })
      }
      yield ENC.encode('good,x\n')
    } finally {
      closed.push(path.virtual)
    }
  }
  const result = await cut(
    ['/missing', '/denied', '/good'].map((p) => PathSpec.fromStrPath(p)),
    { stdin: null, flags: { fields: '1', delimiter: ',' }, cwd: PathSpec.fromStrPath('/') },
    source,
    stat,
  )
  if (result === null) throw new Error('cut returned no result')
  const [out, io] = result
  expect(DEC.decode(await materialize(out))).toBe((prefix ? 'first\n' : '') + 'good\n')
  expect(DEC.decode(await materialize(io.stderr))).toBe(
    'cut: /missing: No such file or directory\ncut: /denied: Permission denied\n',
  )
  expect(io.exitCode).toBe(1)
  expect(closed).toEqual(['/denied', '/good'])
})

it.each([new Error('backend failed'), new DOMException('cancelled', 'AbortError')])(
  'does not continue after a fatal error or cancellation (%s)',
  async (error) => {
    const opened: string[] = []
    async function* source(path: PathSpec): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      opened.push(path.virtual)
      yield await Promise.reject<Uint8Array>(error)
    }
    const result = await cut(
      ['/failed', '/untouched'].map((p) => PathSpec.fromStrPath(p)),
      { stdin: null, flags: { fields: '1' }, cwd: PathSpec.fromStrPath('/') },
      source,
      stat,
    )
    if (result === null) throw new Error('cut returned no result')
    await expect(materialize(result[0])).rejects.toBe(error)
    expect(opened).toEqual(['/failed'])
  },
)

it.each([
  [
    { fields: '-' },
    "cut: invalid range with no endpoint: -\nTry 'cut --help' for more information.\n",
  ],
  [{ fields: '1', bytes: '2' }, 'cut: only one type of list may be specified\n'],
  [{ fields: '1', delimiter: ',,' }, 'cut: the delimiter must be a single character\n'],
  [
    { fields: '1', whitespace_delimited: 'tt' },
    "cut: invalid argument 'tt' for '--whitespace-delimited'\n",
  ],
])('refuses %j in its config, before any operand', async (flags, stderr) => {
  const refusal = cutConfig(flags)
  if (!(refusal instanceof IOResult)) throw new Error('cut read a refused line')
  expect(refusal.exitCode).toBe(1)
  expect(DEC.decode(await materialize(refusal.stderr))).toBe(stderr)
})

it('reads a bare --whitespace-delimited apart from an empty word', async () => {
  for (const [value, expected] of [
    [true, '\n'],
    ['', 'a\n'],
  ] as const) {
    const result = await cut(
      [],
      {
        stdin: ENC.encode(' a  b\n'),
        flags: { fields: '1', whitespace_delimited: value },
        cwd: PathSpec.fromStrPath('/'),
      },
      () => {
        throw new Error('unexpected input read')
      },
      stat,
    )
    if (result === null) throw new Error('cut returned no result')
    expect(DEC.decode(await materialize(result[0]))).toBe(expected)
  }
})

it('preserves a BOM in selected fields', async () => {
  async function* source(_path: PathSpec): AsyncIterable<Uint8Array> {
    yield await Promise.resolve(ENC.encode('\ufeffa,b\n'))
  }
  const result = await cut(
    [],
    {
      stdin: source(PathSpec.fromStrPath('/')),
      flags: { fields: '1', delimiter: ',' },
      cwd: PathSpec.fromStrPath('/'),
    },
    source,
    stat,
  )
  if (result === null) throw new Error('cut returned no result')
  expect(await materialize(result[0])).toEqual(ENC.encode('\ufeffa\n'))
  expect(result[1].exitCode).toBe(0)
})

it.each(['bytes', 'characters', 'fields'])(
  'keeps raw delimiter sentinels distinct from replacement in %s mode',
  async (mode) => {
    for (const input of [Uint8Array.of(97, 255, 98, 10), ENC.encode('a\ufffdb\n')]) {
      const result = await cut(
        [],
        {
          stdin: input,
          flags: { [mode]: '1', delimiter: '\udcff' },
          cwd: PathSpec.fromStrPath('/'),
        },
        () => {
          throw new Error('unexpected input read')
        },
        stat,
      )
      if (result === null) throw new Error('cut returned no result')
      expect(result[1].exitCode).toBe(0)
      expect(await materialize(result[0])).toEqual(mode === 'fields' ? input : ENC.encode('a\n'))
    }
  },
)

it('writes a raw output delimiter byte as typed', async () => {
  const result = await cut(
    [],
    {
      stdin: ENC.encode('abc\n'),
      flags: { bytes: '1,3', output_delimiter: '\udcff' },
      cwd: PathSpec.fromStrPath('/'),
    },
    () => {
      throw new Error('unexpected input read')
    },
    stat,
  )
  if (result === null) throw new Error('cut returned no result')
  expect(result[1].exitCode).toBe(0)
  expect(await materialize(result[0])).toEqual(Uint8Array.of(97, 255, 99, 10))
})
