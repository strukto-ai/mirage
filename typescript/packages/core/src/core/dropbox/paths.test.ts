import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Client from './client.ts'

vi.mock('./client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Client>()),
  dropboxRpc: vi.fn(),
  dropboxDownload: vi.fn(),
  dropboxDownloadStream: vi.fn(),
  dropboxUpload: vi.fn(),
}))

import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import * as client from './client.ts'
import { copy } from './copy.ts'
import { mkdir } from './mkdir.ts'
import { read, readStream } from './read.ts'
import { readdir } from './readdir.ts'
import { rename } from './rename.ts'
import { rmR } from './rm.ts'
import { rmdir } from './rmdir.ts'
import { stat, tree } from './stat.ts'
import { unlink } from './unlink.ts'
import { replace, write } from './write.ts'
import { ABSENT_WRITE } from '../../cache/types.ts'
import { checkPath } from './paths.ts'

const OPERATIONS = [
  'stat',
  'readdir',
  'read',
  'readStream',
  'write',
  'mkdir',
  'unlink',
  'rmdir',
  'rmR',
  'tree',
  'copy_source',
  'copy_destination',
  'rename_source',
  'rename_destination',
] as const

afterEach(() => {
  vi.resetAllMocks()
})

describe('case-aliased ancestors', () => {
  it.each(OPERATIONS)('refuses %s before content or mutation I/O', async (operation) => {
    const touched: string[] = []
    vi.mocked(client.dropboxRpc).mockImplementation((_tm, endpoint, body) => {
      if (endpoint !== '/files/get_metadata') {
        touched.push(endpoint)
        throw new Error('aliased operand reached ' + endpoint)
      }
      const key = (body as { path: string }).path.replace(/^\//, '')
      const name = key.slice(key.lastIndexOf('/') + 1)
      return Promise.resolve({
        '.tag': key.toLowerCase() === 'vault' ? 'folder' : 'file',
        name: key.toLowerCase() === 'vault' ? 'vault' : name,
        size: 6,
      })
    })
    vi.mocked(client.dropboxDownload).mockResolvedValue([new TextEncoder().encode('secret'), null])
    vi.mocked(client.dropboxDownloadStream).mockImplementation(async function* () {
      touched.push('download')
      yield await Promise.resolve(new TextEncoder().encode('secret'))
    })
    const accessor = new DropboxAccessor({ tokenManager: {} as Client.DropboxTokenManager })
    const path = PathSpec.fromStrPath('/Vault/secret.txt')
    const publicPath = PathSpec.fromStrPath('/public.txt')
    const entry = new FileStat({ name: 'secret.txt', type: FileType.FILE, size: 6 })
    const run = async () => {
      if (operation === 'readStream') {
        for await (const chunk of readStream(accessor, path, entry)) {
          touched.push(`bytes:${String(chunk.byteLength)}`)
        }
      } else if (operation === 'read') {
        await read(accessor, path, undefined, entry)
      } else if (operation === 'write') {
        await write(accessor, path, new TextEncoder().encode('changed'))
      } else if (operation.startsWith('copy_') || operation.startsWith('rename_')) {
        const fn = operation.startsWith('copy_') ? copy : rename
        await fn(
          accessor,
          operation.endsWith('_source') ? path : publicPath,
          operation.endsWith('_destination') ? path : publicPath,
        )
      } else {
        const ops = { stat, readdir, mkdir, unlink, rmdir, rmR, tree }
        await ops[operation as keyof typeof ops](accessor, path)
      }
    }
    await expect(run()).rejects.toMatchObject({ code: 'ENOENT' })
    expect(touched).toEqual([])
    expect(client.dropboxDownload).not.toHaveBeenCalled()
    expect(client.dropboxUpload).not.toHaveBeenCalled()
  })
})

it('does not reinterpret an alias as an unsupported create', async () => {
  vi.mocked(client.dropboxRpc).mockResolvedValue({ '.tag': 'file', name: 'secret.txt' })
  const accessor = new DropboxAccessor({ tokenManager: {} as Client.DropboxTokenManager })
  await expect(
    replace(accessor, {
      path: PathSpec.fromStrPath('/SECRET.txt'),
      body: new TextEncoder().encode('changed'),
      condition: ABSENT_WRITE,
    }),
  ).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['exact', 'missing', 'refused', 'root'])(
  'resolves %s without losing error or root semantics',
  async (slot) => {
    const asked: string[] = []
    const refusal = new client.DropboxApiError('refused', 403, 'access_denied')
    vi.mocked(client.dropboxRpc).mockImplementation((_tm, _endpoint, body) => {
      const path = (body as { path: string }).path
      asked.push(path)
      if (slot === 'refused') throw refusal
      if (slot === 'missing' && path.endsWith('/new'))
        throw new client.DropboxApiError('missing', 409, 'path/not_found/...')
      return Promise.resolve({ '.tag': 'folder', name: path.slice(path.lastIndexOf('/') + 1) })
    })
    const accessor = new DropboxAccessor({
      tokenManager: {} as Client.DropboxTokenManager,
      rootPath: '/Configured/Root',
    })
    const path = PathSpec.fromStrPath(
      slot === 'root' ? '/' : '/vault/' + (slot === 'missing' ? 'new/child' : 'secret.txt'),
    )
    if (slot === 'refused') await expect(checkPath(accessor, path)).rejects.toBe(refusal)
    else expect((await checkPath(accessor, path)) === null).toBe(['missing', 'root'].includes(slot))
    expect(asked).toHaveLength(slot === 'root' ? 0 : slot === 'refused' ? 1 : 2)
    expect(asked.every((path) => path.startsWith('/Configured/Root/vault'))).toBe(true)
  },
)
