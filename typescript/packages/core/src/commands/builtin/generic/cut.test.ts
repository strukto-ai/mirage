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
