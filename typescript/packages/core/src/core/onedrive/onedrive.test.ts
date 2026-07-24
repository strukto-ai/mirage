import { afterEach, describe, expect, it, vi } from 'vitest'

import { OneDriveAccessor } from '../../accessor/onedrive.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { runWithRecording } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import { read, readdir, stat, write } from './index.ts'

function requestUrl(input: URL | RequestInfo): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OneDrive filesystem operations', () => {
  it('indexes a directory listing and preserves cTag fingerprints for stat', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            value: [
              {
                id: 'item',
                name: 'a.txt',
                size: 3,
                cTag: 'ctag-1',
                eTag: 'etag-1',
                lastModifiedDateTime: '2026-01-01T00:00:00Z',
                file: {},
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    )
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const index = new RAMIndexCacheStore()
    const folder = PathSpec.fromStrPath('/od/folder', 'folder')
    const file = PathSpec.fromStrPath('/od/folder/a.txt', 'folder/a.txt')

    expect(await readdir(accessor, folder, index)).toEqual(['/od/folder/a.txt'])
    expect(await stat(accessor, file, index)).toMatchObject({
      size: 3,
      fingerprint: 'ctag-1',
    })
  })

  it('records the exact version metadata associated with a download', async () => {
    const fetchMock = vi.fn((input: URL | RequestInfo, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url === 'https://download.test/file') {
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            cTag: 'ctag-1',
            versions: [{ id: 'v1', lastModifiedDateTime: '2026-01-01T00:00:00Z' }],
            '@microsoft.graph.downloadUrl': 'https://download.test/file',
          }),
          { status: 200 },
        ),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const path = PathSpec.fromStrPath('/od/a.bin', 'a.bin')

    const [data, records] = await runWithRecording(() => read(accessor, path))

    expect([...data]).toEqual([1, 2, 3])
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      op: 'read',
      source: 'onedrive',
      fingerprint: 'ctag-1',
      revision: 'v1',
    })
    const downloadInit = fetchMock.mock.calls[1]?.[1]
    expect(downloadInit?.headers).not.toHaveProperty('Authorization')
  })

  it('uses the simple content endpoint for small writes and records the write', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'item' })))
    vi.stubGlobal('fetch', fetchMock)
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const path = PathSpec.fromStrPath('/od/a.txt', 'a.txt')

    const [, records] = await runWithRecording(() =>
      write(accessor, path, new TextEncoder().encode('hello')),
    )

    const writeInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(writeInit?.method).toBe('PUT')
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/root:/a.txt:/content')
    expect(records[0]).toMatchObject({ op: 'write', source: 'onedrive', bytes: 5 })
  })

  it('reports ENOTDIR when readdir targets a file', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'itemNotFound' } }), { status: 404 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'item', name: 'a.txt', size: 3, file: {} }), {
          status: 200,
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const path = PathSpec.fromStrPath('/od/a.txt', 'a.txt')

    await expect(readdir(accessor, path, new RAMIndexCacheStore())).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })
})
