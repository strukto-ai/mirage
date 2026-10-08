import { expect, it } from 'vitest'
import { grepGeneric } from './grep.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { materialize } from '../../../io/types.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()
const tree: Record<string, string[]> = {
  '/d': ['/d/a', '/d/later'],
  '/d/a': ['/d/a/first', '/d/a/later'],
}
const stat = (p: PathSpec): Promise<FileStat> =>
  Promise.resolve(
    new FileStat({
      name: p.virtual,
      type: tree[p.virtual] ? FileType.DIRECTORY : FileType.FILE,
    }),
  )
const readdir = (p: PathSpec): Promise<string[]> => Promise.resolve(tree[p.virtual] ?? [])

it.each([false, true])(
  'recursive grep stops reading and closes its stream (quiet=%s)',
  async (quiet) => {
    const opened: string[] = []
    const closed: string[] = []
    async function* stream(p: PathSpec): AsyncIterable<Uint8Array> {
      opened.push(p.virtual)
      try {
        yield await Promise.resolve(enc.encode('hit\n'))
        throw new Error('read beyond the first match')
      } finally {
        closed.push(p.virtual)
      }
    }
    const result = await grepGeneric(
      'grep',
      ['/d', '/later'].map((p) => PathSpec.fromStrPath(p)),
      ['hit'],
      { flags: { r: true, q: quiet }, stdin: null, cwd: '/' },
      stat,
      readdir,
      stream,
    )
    if (result === null) throw new Error('missing grep result')
    const [output, io] = result
    expect(opened).toEqual([])
    if (output === null || output instanceof Uint8Array) throw new Error('expected a stream')
    if (quiet) {
      expect(await materialize(output)).toEqual(new Uint8Array())
      expect(io.exitCode).toBe(0)
    } else {
      for await (const chunk of output) {
        expect(dec.decode(chunk)).toBe('/d/a/first:hit\n')
        break
      }
    }
    expect(opened).toEqual(['/d/a/first'])
    expect(closed).toEqual(opened)
  },
)

it('recursive quiet grep visits every file when no match exists', async () => {
  const opened: string[] = []
  async function* stream(p: PathSpec): AsyncIterable<Uint8Array> {
    opened.push(p.virtual)
    yield await Promise.resolve(enc.encode('no\n'))
  }
  const result = await grepGeneric(
    'grep',
    [PathSpec.fromStrPath('/d')],
    ['hit'],
    { flags: { r: true, q: true }, stdin: null, cwd: '/' },
    stat,
    readdir,
    stream,
  )
  if (result === null) throw new Error('missing grep result')
  const [output, io] = result
  expect(await materialize(output)).toEqual(new Uint8Array())
  expect(io.exitCode).toBe(1)
  expect(opened).toEqual(['/d/a/first', '/d/a/later', '/d/later'])
})
