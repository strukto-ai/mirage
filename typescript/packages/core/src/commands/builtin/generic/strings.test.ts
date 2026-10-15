import { expect, it } from 'vitest'
import { stringsGeneric } from './strings.ts'
import { PathSpec } from '../../../types.ts'

it('emits before fetching the tail and closes every input', async () => {
  const opened: string[] = [],
    closed: string[] = []
  async function* source(path: PathSpec): AsyncIterable<Uint8Array> {
    opened.push(path.virtual)
    try {
      yield await Promise.resolve(new Uint8Array([102, 105, 114, 115, 116, 0]))
      throw new Error('stream fetched the tail before its first output')
    } finally {
      closed.push(path.virtual)
    }
  }
  const paths = Array.from({ length: 1 }, (_, i) => PathSpec.fromStrPath(`/input${String(i)}`))
  const result = stringsGeneric(paths, { stdin: null, flags: {}, cwd: '/' }, source)
  if (result === null) throw new Error('missing result')
  const [output, io] = result
  if (output === null || output instanceof Uint8Array) throw new Error('expected stream')
  const iterator = output[Symbol.asyncIterator]()
  try {
    expect((await iterator.next()).value).toEqual(new Uint8Array([102, 105, 114, 115, 116, 10]))
  } finally {
    await iterator.return?.()
  }
  expect(opened).toHaveLength(1)
  expect(closed.sort()).toEqual(opened.sort())
  expect(io.exitCode).toBe(0)
})
