import { createServer, type RequestListener } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'
import {
  normalizeDatabricksVolumeConfig,
  redactDatabricksVolumeConfig,
} from '../../vfs/databricks_volume/config.ts'
import {
  deleteFile,
  download,
  downloadStream,
  getMetadata,
  listDirectoryContents,
  upload,
} from './client.ts'
import { read } from './read.ts'
import { stat } from './stat.ts'
import { DatabricksVolumeVFSBase } from '../../vfs/databricks_volume/databricks_volume.ts'
import { jsonResponse, spec } from '../../../tests/core/databricks_volume/_test_util.ts'

const BASE = {
  catalog: 'main',
  schema: 'default',
  volume: 'agent_files',
  host: 'https://dbc.example.com/',
  token: 'tok-123',
}
const accessor = (overrides: Record<string, unknown> = {}) =>
  new DatabricksVolumeAccessor(normalizeDatabricksVolumeConfig({ ...BASE, ...overrides }))

afterEach(() => vi.unstubAllGlobals())

describe('Files client', () => {
  it('escapes path segments without changing their boundaries', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetch)
    await download(accessor(), '/Volumes/main/a %?/中文.txt')
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://dbc.example.com/api/2.0/fs/files/Volumes/main/a%20%25%3F/%E4%B8%AD%E6%96%87.txt',
    )
  })

  it('resolves credentials per page after an empty page and encodes page tokens', async () => {
    const token = vi.fn().mockReturnValueOnce('first').mockResolvedValueOnce('second')
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ contents: [], next_page_token: 'a +%?中文' }))
      .mockResolvedValueOnce(jsonResponse({ contents: [{ path: '/Volumes/x/a', file_size: 3 }] }))
    vi.stubGlobal('fetch', fetch)
    expect(await listDirectoryContents(accessor({ token }), '/Volumes/x')).toEqual([
      { path: '/Volumes/x/a', isDirectory: false, fileSize: 3, lastModified: null },
    ])
    expect(token).toHaveBeenCalledTimes(2)
    expect(
      fetch.mock.calls.map((call) => new Headers(call[1]?.headers).get('authorization')),
    ).toEqual(['Bearer first', 'Bearer second'])
    const target = fetch.mock.calls[1]?.[0]
    if (typeof target !== 'string') throw new Error('expected a string request URL')
    expect(new URL(target).searchParams.get('page_token')).toBe('a +%?中文')
  })

  it('does not resolve credentials for configuration, redaction, deferred streams or zero byte reads', async () => {
    let current = 'old'
    const token = vi.fn(() => current)
    const a = accessor({ token })
    expect(redactDatabricksVolumeConfig(a.config).token).toBe('<REDACTED>')
    const stream = downloadStream(a, '/Volumes/x/a')
    await read(a, spec('/volume/a'), { size: 0 })
    expect(token).not.toHaveBeenCalled()
    current = 'fresh'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('bytes'))
    vi.stubGlobal('fetch', fetch)
    const result = []
    for await (const chunk of stream) result.push(chunk)
    expect(result).toHaveLength(1)
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer fresh')
    expect(token).toHaveBeenCalledTimes(1)
  })

  it('keeps concurrent credentials and request headers independent', async () => {
    let release: (token: string) => void = () => {
      throw new Error('provider not invoked')
    }
    let calls = 0
    const token = () =>
      ++calls === 1
        ? new Promise<string>((resolve) => {
            release = resolve
          })
        : 'second'
    const a = accessor({ token })
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => Promise.resolve(new Response('data')))
    vi.stubGlobal('fetch', fetch)
    const first = download(a, '/Volumes/x/first')
    await download(a, '/Volumes/x/second')
    release('first')
    await first
    expect(
      fetch.mock.calls.map((call) => new Headers(call[1]?.headers).get('authorization')),
    ).toEqual(['Bearer second', 'Bearer first'])
  })

  it('preserves provider failures as a cause before I/O', async () => {
    const failure = new Error('broker token does not exist')
    const fetch = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('fetch', fetch)
    await expect(
      download(
        accessor({
          token: () => Promise.reject(failure),
        }),
        '/Volumes/x/a',
      ),
    ).rejects.toMatchObject({
      message: 'databricks_volume: credential provider failed',
      cause: failure,
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves provider cancellation before I/O', async () => {
    const failure = new DOMException('cancelled', 'AbortError')
    const fetch = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('fetch', fetch)
    await expect(
      download(accessor({ token: () => Promise.reject(failure) }), '/Volumes/x/a'),
    ).rejects.toBe(failure)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['exists', 'append', 'append_empty'])(
    'does not hide or replace an existing file when credentials are missing during %s',
    async (operation) => {
      const failure = Object.assign(new Error('credential file is absent'), { code: 'ENOENT' })
      let calls = 0
      let contents = 'original contents'
      const requests: string[] = []
      const server = await localServer((request, response) => {
        requests.push(request.method ?? '')
        if (request.method === 'PUT') {
          const chunks: Buffer[] = []
          request.on('data', (chunk: Buffer) => chunks.push(chunk))
          request.on('end', () => {
            contents = Buffer.concat(chunks).toString()
            response.end()
          })
        } else {
          response.end(contents)
        }
      })
      const mount = new DatabricksVolumeVFSBase({
        accessor: accessor({
          host: server.host,
          token: () => {
            if (++calls === 1) throw failure
            return 'recovered'
          },
        }),
      })
      const path = spec('/volume/existing.txt')
      try {
        const result =
          operation === 'exists'
            ? mount.exists(path)
            : mount.append(
                path,
                new TextEncoder().encode(operation === 'append_empty' ? '' : ' appended'),
              )
        await expect(result).rejects.toMatchObject({ cause: failure })
        expect(requests).toEqual([])
        expect(contents).toBe('original contents')
        expect(new TextDecoder().decode(await mount.read(path))).toBe('original contents')
      } finally {
        await server.close()
      }
    },
  )

  it.each([401, 403])(
    'does not probe a directory after an auth refusal with status %i',
    async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(() =>
          Promise.resolve(
            jsonResponse(
              { error_code: 'RESOURCE_DOES_NOT_EXIST', message: 'does not exist' },
              status,
            ),
          ),
        )
      vi.stubGlobal('fetch', fetch)
      await expect(stat(accessor(), spec('/volume/file'))).rejects.toMatchObject({
        statusCode: status,
      })
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['', ' ', 'secret\rvalue', 'secret\nvalue', 13])(
    'rejects invalid provider output safely',
    async (value) => {
      const fetch = vi.fn<typeof globalThis.fetch>()
      vi.stubGlobal('fetch', fetch)
      await expect(download(accessor({ token: () => value }), '/Volumes/x/a')).rejects.toThrow(
        'token must be a nonblank string without CR or LF',
      )
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each([401, 403, 429, 500])('never replays a failed upload with status %i', async (status) => {
    const token = vi.fn().mockReturnValue('token')
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ error_code: 'NOT_FOUND', message: 'denied' }, status)),
      )
    vi.stubGlobal('fetch', fetch)
    await expect(
      upload(accessor({ token }), '/Volumes/x/a', new Uint8Array([1]), true),
    ).rejects.toMatchObject({ statusCode: status, errorCode: 'NOT_FOUND' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(token).toHaveBeenCalledTimes(1)
  })

  it('preserves non-JSON error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('plain boom', { status: 500 })))
    await expect(download(accessor(), '/Volumes/x/a')).rejects.toMatchObject({
      statusCode: 500,
      errorCode: null,
      message: 'databricks_volume: HTTP 500 plain boom',
    })
  })

  it('returns normalized metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          headers: { 'Content-Length': '12', 'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT' },
        }),
      ),
    )
    expect(await getMetadata(accessor(), '/Volumes/x/a')).toEqual({
      contentLength: 12,
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
    })
  })

  it('rejects malformed listings at the transport boundary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ contents: [{ path: 123 }] })))
    await expect(listDirectoryContents(accessor(), '/Volumes/x')).rejects.toThrow()
  })
})

describe('explicit configuration', () => {
  it.each([
    'https://u:p@host',
    'https://host/path',
    'https://host?key=x',
    'https://host#frag',
    'ftp://host',
    '',
  ])('rejects unsafe host %s', (host) => {
    expect(() => accessor({ host })).toThrow()
  })
  it.each(['', ' ', 'private\rvalue', 'private\nvalue'])(
    'rejects invalid static credentials safely',
    (token) => {
      expect(() => accessor({ token })).toThrow('token must be nonblank without CR or LF')
    },
  )
  it('requires both host and token and rejects profile', () => {
    expect(() =>
      normalizeDatabricksVolumeConfig({ catalog: 'a', schema: 'b', volume: 'c' }),
    ).toThrow()
    expect(() => accessor({ profile: 'DEFAULT' })).toThrow()
    expect(accessor({ host: 'http://localhost:8080/' }).host).toBe('http://localhost:8080')
  })
})

async function localServer(
  route: RequestListener,
): Promise<{ host: string; close: () => Promise<void> }> {
  const server = createServer(route)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing listener address')
  return {
    host: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
        server.closeAllConnections()
      }),
  }
}

describe('Files client HTTP lifecycle', () => {
  it.each(['buffered', 'stream'])(
    'accepts fractional-second timeouts for %s requests',
    async (mode) => {
      let requests = 0
      const server = await localServer((_request, response) => {
        requests += 1
        response.end('data')
      })
      try {
        const a = accessor({ host: server.host, timeout: 1.001 })
        if (mode === 'buffered') {
          expect(new TextDecoder().decode(await download(a, '/Volumes/x/a'))).toBe('data')
        } else {
          const chunks = []
          for await (const chunk of downloadStream(a, '/Volumes/x/a')) chunks.push(...chunk)
          expect(new TextDecoder().decode(new Uint8Array(chunks))).toBe('data')
        }
        expect(requests).toBe(1)
      } finally {
        await server.close()
      }
    },
  )

  it.each(['PUT', 'DELETE', 'GET', 'HEAD'])(
    'does not replay a completed %s after disconnect',
    async (method) => {
      const seen: { method: string | undefined; auth: string | undefined; body: string }[] = []
      const server = await localServer((request) => {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.once('end', () => {
          seen.push({
            method: request.method,
            auth: request.headers.authorization,
            body: Buffer.concat(chunks).toString(),
          })
          request.socket.destroy()
        })
      })
      try {
        const token = vi.fn().mockReturnValue('generation-one')
        const a = accessor({ host: server.host, token })
        const operation =
          method === 'PUT'
            ? upload(a, '/Volumes/x/a', new TextEncoder().encode('committed'), true)
            : method === 'DELETE'
              ? deleteFile(a, '/Volumes/x/a')
              : method === 'HEAD'
                ? getMetadata(a, '/Volumes/x/a')
                : download(a, '/Volumes/x/a')
        await expect(operation).rejects.toThrow()
        expect(seen).toEqual([
          { method, auth: 'Bearer generation-one', body: method === 'PUT' ? 'committed' : '' },
        ])
        expect(token).toHaveBeenCalledTimes(1)
      } finally {
        await server.close()
      }
    },
  )

  it('rotates same-principal credentials and preserves encoded paths and range semantics', async () => {
    const seen: {
      auth: string | undefined
      path: string | undefined
      range: string | undefined
    }[] = []
    const server = await localServer((request, response) => {
      seen.push({
        auth: request.headers.authorization,
        path: request.url,
        range: request.headers.range,
      })
      if (!['Bearer old', 'Bearer fresh'].includes(request.headers.authorization ?? '')) {
        response.writeHead(401).end()
        return
      }
      response.writeHead(request.url?.endsWith('/partial') === true ? 206 : 200)
      response.end(request.url?.endsWith('/partial') === true ? '34' : '0123456789')
    })
    try {
      let current = 'old'
      const a = accessor({ host: server.host, token: () => current })
      expect(
        new TextDecoder().decode(await download(a, '/Volumes/x/a %?/中文', { offset: 3, size: 2 })),
      ).toBe('34')
      current = 'fresh'
      expect(
        new TextDecoder().decode(await download(a, '/Volumes/x/partial', { offset: 3, size: 2 })),
      ).toBe('34')
      expect(seen).toEqual([
        {
          auth: 'Bearer old',
          path: '/api/2.0/fs/files/Volumes/x/a%20%25%3F/%E4%B8%AD%E6%96%87',
          range: 'bytes=3-4',
        },
        { auth: 'Bearer fresh', path: '/api/2.0/fs/files/Volumes/x/partial', range: 'bytes=3-4' },
      ])
    } finally {
      await server.close()
    }
  })

  it.each(['buffered', 'stream'])(
    'keeps the timeout active while reading the %s response body',
    async (mode) => {
      const server = await localServer((_request, response) => {
        response.writeHead(200, { 'Content-Length': '10' })
        response.write('a')
      })
      try {
        const a = accessor({ host: server.host, timeout: 0.1 })
        if (mode === 'buffered') {
          await expect(download(a, '/Volumes/x/slow')).rejects.toThrow()
        } else {
          const stream = downloadStream(a, '/Volumes/x/slow')[Symbol.asyncIterator]()
          expect((await stream.next()).done).toBe(false)
          await expect(stream.next()).rejects.toThrow()
        }
      } finally {
        await server.close()
      }
    },
  )

  it('closes a live response when stream consumption ends early', async () => {
    let closed: Promise<void> = Promise.resolve()
    const server = await localServer((_request, response) => {
      closed = new Promise<void>((resolve) => response.once('close', resolve))
      response.writeHead(200)
      response.write('data')
    })
    try {
      const stream = downloadStream(accessor({ host: server.host }), '/Volumes/x/open')[
        Symbol.asyncIterator
      ]()
      expect((await stream.next()).done).toBe(false)
      await stream.return?.()
      await closed
    } finally {
      await server.close()
    }
  })
})
