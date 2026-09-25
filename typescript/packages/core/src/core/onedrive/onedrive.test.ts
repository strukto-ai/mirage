import { afterEach, describe, expect, it, vi } from 'vitest'

import { OneDriveAccessor } from '../../accessor/onedrive.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { runWithRecording } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import { create, find, read, readdir, stat, stream, write } from './index.ts'

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

  it('keeps a folder aggregate size out of FileStat.size', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'folder',
            name: 'Docs',
            size: 4096,
            lastModifiedDateTime: '2026-01-01T00:00:00Z',
            folder: { childCount: 2 },
          }),
          { status: 200 },
        ),
      ),
    )
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const info = await stat(accessor, PathSpec.fromStrPath('/od/Docs', 'Docs'))

    expect(info.size).toBeNull()
    expect(info.extra).toMatchObject({ size_bytes: 4096, child_count: 2 })
  })

  it('keeps the root aggregate size out of FileStat.size', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'root',
            name: 'root',
            size: 123456,
            lastModifiedDateTime: '2026-01-01T00:00:00Z',
            folder: { childCount: 3 },
          }),
          { status: 200 },
        ),
      ),
    )
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const info = await stat(accessor, PathSpec.fromStrPath('/'))

    expect(info.size).toBeNull()
    expect(info.extra).toMatchObject({ size_bytes: 123456, child_count: 3 })
  })

  it('matches -empty against a childless folder', async () => {
    const fetchMock = vi.fn((input: URL | RequestInfo) => {
      const url = requestUrl(input)
      if (url.includes('/root:/hollow:/children') || url.includes('/root:/full:/children')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              value: url.includes('hollow') ? [] : [{ id: '4', name: 'c.txt', size: 1, file: {} }],
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            value: [
              { id: '1', name: 'a.txt', size: 3, file: {} },
              { id: '2', name: 'hollow', folder: { childCount: 0 } },
              { id: '3', name: 'full', folder: { childCount: 1 } },
            ],
          }),
          { status: 200 },
        ),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const accessor = new OneDriveAccessor({ accessToken: 'token' })

    expect(
      await find(accessor, PathSpec.fromStrPath('/od', ''), { type: 'd', empty: true }),
    ).toEqual(['/hollow'])
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

  it('reports ENOTDIR for an operand under a file', async () => {
    // Graph 404s the children of `/a.txt/x` exactly as it does those of a
    // name that is simply absent, so only the ancestor walk can tell GNU's
    // "Not a directory" from "No such file or directory".
    const missing = new Response(JSON.stringify({ error: { code: 'itemNotFound' } }), {
      status: 404,
    })
    const fetchMock = vi.fn().mockImplementation((url: unknown) => {
      const href = String(url)
      if (href.endsWith('/root:/a.txt')) {
        return Promise.resolve(
          new Response(JSON.stringify({ id: 'item', name: 'a.txt', size: 3, file: {} }), {
            status: 200,
          }),
        )
      }
      return Promise.resolve(missing.clone())
    })
    vi.stubGlobal('fetch', fetchMock)
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const path = PathSpec.fromStrPath('/od/a.txt/x', 'a.txt/x')

    await expect(readdir(accessor, path, new RAMIndexCacheStore())).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })

  it('reports ENOENT for a path no component of which exists', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'itemNotFound' } }), { status: 404 }),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const path = PathSpec.fromStrPath('/od/nope/deeper', 'nope/deeper')

    await expect(readdir(accessor, path, new RAMIndexCacheStore())).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

// A key named like its mount: neither `m/k.txt` nor `/m/k.txt` is virtual.
describe('OneDrive record paths', () => {
  const spec = new PathSpec({ virtual: '/m/m/k.txt', vfsPath: 'm/k.txt', directory: '/m/m/' })

  function versionedFetch(): ReturnType<typeof vi.fn> {
    return vi.fn((input: URL | RequestInfo) => {
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
  }

  it('write records the virtual path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'i' }))))
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const [, records] = await runWithRecording(() =>
      write(accessor, spec, new TextEncoder().encode('hello')),
    )
    expect(records.map((r) => r.op)).toEqual(['write'])
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
  })

  it('create records the virtual path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'i' }))))
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const [, records] = await runWithRecording(() => create(accessor, spec))
    expect(records.map((r) => r.op)).toEqual(['write'])
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
  })

  // msgraph readItem, through its public caller.
  it('read records the virtual path', async () => {
    vi.stubGlobal('fetch', versionedFetch())
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const [data, records] = await runWithRecording(() => read(accessor, spec))
    expect([...data]).toEqual([1, 2, 3])
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
  })

  // msgraph streamItem, through its public caller.
  it('stream records the virtual path', async () => {
    vi.stubGlobal('fetch', versionedFetch())
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const [bytes, records] = await runWithRecording(async () => {
      const out: number[] = []
      for await (const chunk of stream(accessor, spec)) out.push(...chunk)
      return out
    })
    expect(bytes).toEqual([1, 2, 3])
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
  })
})

const ITEM = 'https://graph.microsoft.com/v1.0/me/drive/root:/a.bin'
const DOWNLOAD = 'https://download.test/a.bin'

// Routes by URL without its query and logs each call's URL, Authorization and
// Range; an unrouted URL throws, so a request the read should not make fails.
function routed(routes: Record<string, () => Response>) {
  const calls: [string, string | undefined, string | undefined][] = []
  const fetchMock = vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
    const url = requestUrl(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push([url.split('?')[0] ?? url, headers.Authorization, headers.Range])
    const route = routes[url.split('?')[0] ?? url]
    if (route === undefined) throw new Error(`unrouted ${url}`)
    return Promise.resolve(route())
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

function itemJson(download: string | null = DOWNLOAD): Response {
  return new Response(
    JSON.stringify({
      id: 'item',
      cTag: 'ctag-1',
      eTag: 'etag-1',
      ...(download === null ? {} : { '@microsoft.graph.downloadUrl': download }),
    }),
    { status: 200 },
  )
}

describe('an unrecorded OneDrive read', () => {
  const path = PathSpec.fromStrPath('/od/a.bin', 'a.bin')

  it('fetches the item, then its download URL without the bearer token', async () => {
    const calls = routed({
      [ITEM]: () => itemJson(),
      [DOWNLOAD]: () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    })
    const data = await read(new OneDriveAccessor({ accessToken: 'token' }), path)
    expect([...data]).toEqual([1, 2, 3])
    // The token comes first, so a write between the two requests can only
    // make the cached bytes look stale.
    expect(calls.map(([url, auth]) => [url, auth])).toEqual([
      [ITEM, 'Bearer token'],
      [DOWNLOAD, undefined],
    ])
  })

  it('falls back to /content when Graph omits the download URL', async () => {
    const calls = routed({
      [ITEM]: () => itemJson(null),
      [`${ITEM}:/content`]: () => new Response(new Uint8Array([4, 5]), { status: 200 }),
    })
    const data = await read(new OneDriveAccessor({ accessToken: 'token' }), path)
    expect([...data]).toEqual([4, 5])
    expect(calls.map(([url, auth]) => [url, auth])).toEqual([
      [ITEM, 'Bearer token'],
      [`${ITEM}:/content`, 'Bearer token'],
    ])
  })

  it('reports ENOENT with the virtual path when the item is missing', async () => {
    routed({
      [ITEM]: () =>
        new Response(JSON.stringify({ error: { code: 'itemNotFound', message: 'no' } }), {
          status: 404,
        }),
    })
    await expect(
      read(new OneDriveAccessor({ accessToken: 'token' }), path),
    ).rejects.toMatchObject({ code: 'ENOENT', message: expect.stringContaining('/od/a.bin') })
  })

  it('sends a window to the download URL and slices a 200 answer locally', async () => {
    const calls = routed({
      [ITEM]: () => itemJson(),
      [DOWNLOAD]: () => new Response(new TextEncoder().encode('hello'), { status: 200 }),
    })
    const data = await read(new OneDriveAccessor({ accessToken: 'token' }), path, undefined, {
      offset: 2,
      size: 3,
    })
    expect(new TextDecoder().decode(data)).toBe('llo')
    expect(calls[1]).toEqual([DOWNLOAD, undefined, 'bytes=2-4'])
  })
})

describe('a OneDrive folder served from the index', () => {
  it('carries no fingerprint, as a network stat of a folder does not', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            value: [
              {
                id: 'dir',
                name: 'Docs',
                cTag: 'ctag-dir',
                eTag: 'etag-dir',
                lastModifiedDateTime: '2026-01-01T00:00:00Z',
                folder: { childCount: 1 },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    )
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const index = new RAMIndexCacheStore()
    await readdir(accessor, PathSpec.fromStrPath('/od', ''), index)
    const docs = await stat(accessor, PathSpec.fromStrPath('/od/Docs', 'Docs'), index)
    expect(docs.type).toBe('directory')
    expect(docs.fingerprint).toBeNull()
  })
})
