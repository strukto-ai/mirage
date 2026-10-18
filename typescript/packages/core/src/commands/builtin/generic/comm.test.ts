import { expect, it } from 'vitest'
import { PathSpec } from '../../../types.ts'
import { materialize } from '../../../io/types.ts'
import { commGeneric } from './comm.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

it.each([
  ['', '', false, []],
  ['a\n', '', true, [97, 10]],
  ['', 'b\n', false, [255, 98, 10]],
  ['a\n', 'a\n', false, [255, 255, 97, 10]],
] as const)(
  'keeps a raw output separator for %j and %j',
  async (left, right, suppressed, expected) => {
    async function* read(path: PathSpec): AsyncIterable<Uint8Array> {
      yield await Promise.resolve(ENC.encode(path.virtual === '/left' ? left : right))
    }
    const result = commGeneric(
      [PathSpec.fromStrPath('/left'), PathSpec.fromStrPath('/right')],
      {
        flags: { output_delimiter: '\udcff', '2': suppressed, '3': suppressed },
        stdin: null,
        cwd: PathSpec.fromStrPath('/'),
      },
      read,
    )
    if (result === null) throw new Error('missing comm result')
    expect(await materialize(result[0])).toEqual(Uint8Array.from(expected))
    expect(result[1].exitCode).toBe(0)
    expect(await materialize(result[1].stderr)).toEqual(new Uint8Array())
  },
)

it('prints Unicode output separators', async () => {
  async function* read(path: PathSpec): AsyncIterable<Uint8Array> {
    yield await Promise.resolve(ENC.encode(path.virtual === '/left' ? 'a\n' : 'b\n'))
  }
  const result = commGeneric(
    [PathSpec.fromStrPath('/left'), PathSpec.fromStrPath('/right')],
    { flags: { output_delimiter: 'λ' }, stdin: null, cwd: PathSpec.fromStrPath('/') },
    read,
  )
  if (result === null) throw new Error('missing comm result')
  expect(await materialize(result[0])).toEqual(ENC.encode('a\nλb\n'))
  expect(result[1].exitCode).toBe(0)
})

it('defers the disorder summary until the consumer resumes past total', async () => {
  async function* read(path: PathSpec): AsyncIterable<Uint8Array> {
    yield await Promise.resolve(ENC.encode(path.virtual === '/left' ? 'b\na\n' : 'z\n'))
  }
  const result = commGeneric(
    [PathSpec.fromStrPath('/left'), PathSpec.fromStrPath('/right')],
    { flags: { total: true }, stdin: null, cwd: PathSpec.fromStrPath('/') },
    read,
  )
  if (!result?.[0] || result[0] instanceof Uint8Array) throw new Error('missing comm output')
  const stream = result[0][Symbol.asyncIterator]()
  for (;;) {
    const piece = await stream.next()
    if (piece.done === true) throw new Error('missing total')
    if (DEC.decode(piece.value).includes('total')) break
  }
  await stream.return?.()
  expect(DEC.decode(await materialize(result[1].stderr))).toBe(
    'comm: file 1 is not in sorted order\n',
  )
})

it.each([1, 3, 65536])('keeps one shared stdin record cursor at chunk size %s', async (size) => {
  const closed: boolean[] = []
  async function* source(): AsyncIterable<Uint8Array> {
    try {
      const data = ENC.encode('a\nb\nc\nd\n')
      for (let start = 0; start < data.length; start += size)
        yield await Promise.resolve(data.subarray(start, start + size))
    } finally {
      closed.push(true)
    }
  }
  const result = commGeneric(
    [PathSpec.fromStrPath('-'), PathSpec.fromStrPath('-')],
    { flags: { total: true }, stdin: source(), cwd: PathSpec.fromStrPath('/') },
    () => {
      throw new Error('stdin must not open a file')
    },
  )
  if (result === null) throw new Error('comm returned no result')
  const [output, io] = result
  expect(DEC.decode(await materialize(output))).toBe('a\n\tb\nc\n\td\n')
  expect(DEC.decode(await materialize(io.stderr))).toBe('comm: -: Bad file descriptor\n')
  expect(io.exitCode).toBe(1)
  expect(closed).toEqual([true])
})

it('delivers output before pulling a future record and closes its sources', async () => {
  const pulled: boolean[] = []
  const closed: string[] = []
  async function* source(path: PathSpec): AsyncIterable<Uint8Array> {
    try {
      if (path.virtual === '/left') {
        yield await Promise.resolve(ENC.encode('first\n'))
        pulled.push(true)
        throw new Error('consumer stopped before the future record')
      }
    } finally {
      closed.push(path.virtual)
    }
  }
  const result = commGeneric(
    [PathSpec.fromStrPath('/left'), PathSpec.fromStrPath('/right')],
    { flags: {}, stdin: null, cwd: PathSpec.fromStrPath('/') },
    source,
  )
  if (!result?.[0] || result[0] instanceof Uint8Array)
    throw new Error('comm did not return a stream')
  const stream = result[0][Symbol.asyncIterator]()
  const first = await stream.next()
  if (first.done === true) throw new Error('comm produced no output')
  expect(DEC.decode(first.value)).toBe('first\n')
  await stream.return?.()
  expect(pulled).toEqual([])
  expect(closed.sort()).toEqual(['/left', '/right'])
})
