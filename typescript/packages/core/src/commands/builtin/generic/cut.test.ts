import { expect, it } from 'vitest'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { materialize } from '../../../io/types.ts'
import { cutGeneric } from './cut.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

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
  const result = await cutGeneric(
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
    const result = await cutGeneric(
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

it('refuses the list before input stat or read', async () => {
  function noStat(_path: PathSpec): Promise<FileStat> {
    throw new Error('cut stat before list refusal')
  }
  async function* noRead(_path: PathSpec): AsyncIterable<Uint8Array> {
    yield await Promise.reject<Uint8Array>(new Error('cut read before list refusal'))
  }
  const result = await cutGeneric(
    [PathSpec.fromStrPath('/missing')],
    { stdin: null, flags: { fields: '-' }, cwd: PathSpec.fromStrPath('/') },
    noRead,
    noStat,
  )
  if (result === null) throw new Error('cut returned no result')
  expect(result[0]).toBeNull()
  expect(result[1].exitCode).toBe(1)
  expect(DEC.decode(await materialize(result[1].stderr))).toBe(
    "cut: invalid range with no endpoint: -\nTry 'cut --help' for more information.\n",
  )
})

it('preserves a BOM in selected fields', async () => {
  async function* source(_path: PathSpec): AsyncIterable<Uint8Array> {
    yield await Promise.resolve(ENC.encode('\ufeffa,b\n'))
  }
  const result = await cutGeneric(
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
      const result = await cutGeneric(
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

it('keeps replacement encoding for raw output delimiters', async () => {
  const result = await cutGeneric(
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
  expect(await materialize(result[0])).toEqual(ENC.encode('a\ufffdc\n'))
})
