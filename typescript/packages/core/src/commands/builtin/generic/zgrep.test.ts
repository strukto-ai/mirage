import { expect, it } from 'vitest'
import { closeQuietly, ensureStream } from '../../../io/stream.ts'
import { PathSpec } from '../../../types.ts'
import { gzip } from '../../../utils/compress.ts'
import { zgrepGeneric } from './zgrep.ts'

const ENC = new TextEncoder()

it.each([
  [{ count: true }, '2\n'],
  [{ files_with_matches: true }, '/f.gz\n'],
  [{ only_matching: true }, 'hello\n'],
] as const)('settles status and closes the reader on early close: %j', async (flags, expected) => {
  let closed = false
  let reads = 0
  const compressed = await gzip(ENC.encode('hello\n'))
  async function* read(): AsyncGenerator<Uint8Array> {
    try {
      for (let i = 0; i < 2; i++) {
        reads += 1
        yield await Promise.resolve(compressed)
      }
    } finally {
      closed = true
    }
  }
  const result = await zgrepGeneric(
    [PathSpec.fromStrPath('/f.gz')],
    ['hello'],
    { flags, stdin: null, cwd: PathSpec.fromStrPath('/') },
    read,
  )
  if (result === null) throw new Error('zgrep returned no result')
  const [body, io] = result
  const output = ensureStream(body ?? new Uint8Array())[Symbol.asyncIterator]()
  try {
    expect((await output.next()).value).toEqual(ENC.encode(expected))
  } finally {
    await closeQuietly(output)
  }
  expect(io.exitCode).toBe(0)
  expect(await io.stderrStr()).toBe('')
  expect(closed).toBe(true)
  expect(reads).toBe('count' in flags ? 2 : 1)
})

it('keeps a trailer failure and its diagnostic on early close', async () => {
  const compressed = await gzip(ENC.encode('hello\n'))
  const damaged = compressed.map((byte, index) =>
    index === compressed.length - 8 ? byte ^ 1 : byte,
  )
  async function* read(): AsyncGenerator<Uint8Array> {
    yield await Promise.resolve(damaged)
  }
  const result = await zgrepGeneric(
    [PathSpec.fromStrPath('/f.gz')],
    ['hello'],
    { flags: { count: true }, stdin: null, cwd: PathSpec.fromStrPath('/') },
    read,
  )
  if (result === null) throw new Error('zgrep returned no result')
  const [body, io] = result
  const output = ensureStream(body ?? new Uint8Array())[Symbol.asyncIterator]()
  try {
    expect((await output.next()).value).toEqual(ENC.encode('1\n'))
  } finally {
    await closeQuietly(output)
  }
  expect(io.exitCode).toBe(2)
  expect(await io.stderrStr()).toContain('crc error')
})
