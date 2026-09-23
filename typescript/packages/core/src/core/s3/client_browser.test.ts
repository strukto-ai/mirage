// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { S3BrowserPresignedUrlProvider, S3BrowserSignOptions } from '../../vfs/s3/config.ts'
import { BROWSER_S3_MODULE, createBrowserS3Client } from './client_browser.ts'

interface FetchCall {
  url: string
  init?: RequestInit
}

function installFetch(handler: (req: FetchCall) => Response | Promise<Response>): {
  calls: FetchCall[]
  restore: () => void
} {
  const calls: FetchCall[] = []
  const original = globalThis.fetch
  const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const call: FetchCall = { url }
    if (init !== undefined) call.init = init
    calls.push(call)
    return handler(call)
  })
  globalThis.fetch = fake as unknown as typeof globalThis.fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

function makeProvider(impl: (path: string, op: string, opts?: S3BrowserSignOptions) => string): {
  provider: S3BrowserPresignedUrlProvider
  calls: { path: string; op: string; opts?: S3BrowserSignOptions }[]
} {
  const calls: { path: string; op: string; opts?: S3BrowserSignOptions }[] = []
  const provider: S3BrowserPresignedUrlProvider = (path, op, opts) => {
    const entry: { path: string; op: string; opts?: S3BrowserSignOptions } = { path, op }
    if (opts !== undefined) entry.opts = opts
    calls.push(entry)
    return Promise.resolve(impl(path, op, opts))
  }
  return { provider, calls }
}

function cfg(provider: S3BrowserPresignedUrlProvider) {
  return { bucket: 'irrelevant', presignedUrlProvider: provider }
}

describe('BROWSER_S3_MODULE command classes', () => {
  it('tags every command with __mirageTag and stores input unchanged', () => {
    const {
      GetObjectCommand,
      HeadObjectCommand,
      ListObjectsV2Command,
      PutObjectCommand,
      DeleteObjectCommand,
      DeleteObjectsCommand,
      CopyObjectCommand,
    } = BROWSER_S3_MODULE
    const get = new GetObjectCommand({ Bucket: 'b', Key: 'k' }) as {
      __mirageTag: string
      input: Record<string, unknown>
    }
    expect(get.__mirageTag).toBe('Get')
    expect(get.input).toEqual({ Bucket: 'b', Key: 'k' })

    const head = new HeadObjectCommand({ Bucket: 'b', Key: 'k' }) as {
      __mirageTag: string
    }
    expect(head.__mirageTag).toBe('Head')

    const list = new ListObjectsV2Command({ Bucket: 'b' }) as {
      __mirageTag: string
    }
    expect(list.__mirageTag).toBe('List')

    const put = new PutObjectCommand({ Bucket: 'b', Key: 'k' }) as {
      __mirageTag: string
    }
    expect(put.__mirageTag).toBe('Put')

    const del = new DeleteObjectCommand({ Bucket: 'b', Key: 'k' }) as {
      __mirageTag: string
    }
    expect(del.__mirageTag).toBe('Delete')

    const dels = new DeleteObjectsCommand({
      Bucket: 'b',
      Delete: { Objects: [{ Key: 'a' }, { Key: 'b' }] },
    }) as { __mirageTag: string }
    expect(dels.__mirageTag).toBe('Delete')

    const cp = new CopyObjectCommand({ Bucket: 'b', Key: 'dst' }) as {
      __mirageTag: string
    }
    expect(cp.__mirageTag).toBe('Copy')
  })

  it('stub S3Client throws a helpful error if instantiated', () => {
    const Ctor = BROWSER_S3_MODULE.S3Client as unknown as new (
      options: Record<string, unknown>,
    ) => unknown
    expect(() => new Ctor({})).toThrow(/stub/)
  })
})

describe('createBrowserS3Client — command dispatch', () => {
  let fetchHandle: ReturnType<typeof installFetch>

  afterEach(() => {
    fetchHandle.restore()
  })

  it('GET returns Body as AsyncIterable and surfaces Content-Length/ETag/LastModified', async () => {
    const { provider, calls } = makeProvider(() => 'https://signed/get')
    fetchHandle = installFetch(
      () =>
        new Response(new Uint8Array([104, 105]), {
          status: 200,
          headers: {
            'content-length': '2',
            etag: '"abc123"',
            'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
          },
        }),
    )

    const client = createBrowserS3Client(cfg(provider))
    const { GetObjectCommand } = BROWSER_S3_MODULE
    const resp = await client.send(new GetObjectCommand({ Bucket: 'b', Key: 'hello.txt' }))

    expect(calls[0]).toEqual({ path: '/hello.txt', op: 'GET' })
    expect(fetchHandle.calls[0]?.url).toBe('https://signed/get')
    expect(resp.ContentLength).toBe(2)
    expect(resp.ETag).toBe('abc123')
    expect(resp.LastModified).toBeInstanceOf(Date)

    const body = resp.Body as AsyncIterable<Uint8Array>
    const chunks: number[] = []
    for await (const c of body) chunks.push(...c)
    expect(chunks).toEqual([104, 105])
  })

  it('GET 404 throws with $metadata.httpStatusCode so isNotFoundError matches', async () => {
    const { provider } = makeProvider(() => 'https://signed/404')
    fetchHandle = installFetch(() => new Response('', { status: 404 }))
    const client = createBrowserS3Client(cfg(provider))
    const { GetObjectCommand } = BROWSER_S3_MODULE
    await expect(
      client.send(new GetObjectCommand({ Bucket: 'b', Key: 'missing' })),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } })
  })

  // A presigned URL is signed for a key, not a version. Before this refusal the
  // shim read only Key, so a snapshot-pinned read fetched and returned whichever
  // version was current -- no error, no log, just the wrong bytes. Asserting
  // that neither the provider nor fetch ran is what distinguishes refusing from
  // answering: the old code reached both and resolved.
  it('GET refuses a version-pinned read instead of returning the current object', async () => {
    const { provider, calls } = makeProvider(() => 'https://signed/get')
    fetchHandle = installFetch(() => new Response(new Uint8Array([104, 105]), { status: 200 }))
    const client = createBrowserS3Client(cfg(provider))
    const { GetObjectCommand } = BROWSER_S3_MODULE
    await expect(
      client.send(new GetObjectCommand({ Bucket: 'b', Key: 'pinned.txt', VersionId: 'v2' })),
    ).rejects.toThrow(/cannot serve a version-pinned read/)
    expect(calls).toEqual([])
    expect(fetchHandle.calls).toEqual([])
  })

  it('HEAD refuses a version-pinned stat for the same reason', async () => {
    const { provider, calls } = makeProvider(() => 'https://signed/head')
    fetchHandle = installFetch(() => new Response('', { status: 200 }))
    const client = createBrowserS3Client(cfg(provider))
    const { HeadObjectCommand } = BROWSER_S3_MODULE
    await expect(
      client.send(new HeadObjectCommand({ Bucket: 'b', Key: 'pinned.txt', VersionId: 'v2' })),
    ).rejects.toThrow(/cannot serve a version-pinned read/)
    expect(calls).toEqual([])
    expect(fetchHandle.calls).toEqual([])
  })

  // MaxKeys is the counter-example the refusal must not swallow: `stat`'s
  // directory probe sends it, the shim ignores it, and ignoring it returns more
  // data but the same answer. Only fields that change the answer may refuse.
  it('LIST still ignores a MaxKeys hint rather than refusing it', async () => {
    const { provider } = makeProvider(() => 'https://signed/list')
    fetchHandle = installFetch(
      () =>
        new Response(
          '<?xml version="1.0"?><ListBucketResult><Contents><Key>a.txt</Key>' +
            '<Size>1</Size></Contents></ListBucketResult>',
          { status: 200 },
        ),
    )
    const client = createBrowserS3Client(cfg(provider))
    const { ListObjectsV2Command } = BROWSER_S3_MODULE
    const resp = await client.send(
      new ListObjectsV2Command({ Bucket: 'b', Prefix: '', Delimiter: '/', MaxKeys: 1 }),
    )
    expect((resp.Contents as unknown[]).length).toBe(1)
  })

  it('HEAD returns only metadata (no Body)', async () => {
    const { provider, calls } = makeProvider(() => 'https://signed/head')
    fetchHandle = installFetch(
      () =>
        new Response(null, {
          status: 200,
          headers: {
            'content-length': '42',
            etag: '"feed"',
            'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
          },
        }),
    )

    const client = createBrowserS3Client(cfg(provider))
    const { HeadObjectCommand } = BROWSER_S3_MODULE
    const resp = await client.send(new HeadObjectCommand({ Bucket: 'b', Key: 'k' }))

    expect(calls[0]).toEqual({ path: '/k', op: 'HEAD' })
    expect(fetchHandle.calls[0]?.init?.method).toBe('HEAD')
    expect(resp.ContentLength).toBe(42)
    expect(resp.ETag).toBe('feed')
    expect(resp.Body).toBeUndefined()
  })

  it('LIST parses XML into AWS-SDK-shaped response (CommonPrefixes / Contents / IsTruncated)', async () => {
    const { provider, calls } = makeProvider(() => 'https://signed/list')
    const xml = `<?xml version="1.0"?>
      <ListBucketResult>
        <IsTruncated>true</IsTruncated>
        <NextContinuationToken>tok123</NextContinuationToken>
        <CommonPrefixes><Prefix>data/</Prefix></CommonPrefixes>
        <CommonPrefixes><Prefix>logs/</Prefix></CommonPrefixes>
        <Contents>
          <Key>file1.txt</Key>
          <Size>7</Size>
          <ETag>"a1"</ETag>
          <LastModified>2024-01-01T00:00:00.000Z</LastModified>
        </Contents>
        <Contents>
          <Key>file2.txt</Key>
          <Size>11</Size>
          <ETag>"b2"</ETag>
        </Contents>
      </ListBucketResult>`
    fetchHandle = installFetch(() => new Response(xml, { status: 200 }))

    const client = createBrowserS3Client(cfg(provider))
    const { ListObjectsV2Command } = BROWSER_S3_MODULE
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: 'b',
        Prefix: 'data/',
        Delimiter: '/',
        ContinuationToken: 'prev',
      }),
    )

    expect(calls[0]?.op).toBe('LIST')
    expect(calls[0]?.opts).toEqual({
      listPrefix: 'data/',
      listDelimiter: '/',
      listContinuationToken: 'prev',
    })
    expect(resp.CommonPrefixes).toEqual([{ Prefix: 'data/' }, { Prefix: 'logs/' }])
    const contents = resp.Contents as {
      Key: string
      Size: number
      ETag?: string
      LastModified?: Date
    }[]
    expect(contents).toHaveLength(2)
    expect(contents[0]).toMatchObject({ Key: 'file1.txt', Size: 7, ETag: 'a1' })
    expect(contents[0]?.LastModified).toBeInstanceOf(Date)
    expect(contents[1]).toMatchObject({ Key: 'file2.txt', Size: 11, ETag: 'b2' })
    expect(contents[1]?.LastModified).toBeUndefined()
    expect(resp.IsTruncated).toBe(true)
    expect(resp.NextContinuationToken).toBe('tok123')
  })

  it('LIST without prefix/delimiter still signs with empty listPrefix', async () => {
    const { provider, calls } = makeProvider(() => 'https://signed/list')
    fetchHandle = installFetch(
      () => new Response('<ListBucketResult></ListBucketResult>', { status: 200 }),
    )

    const client = createBrowserS3Client(cfg(provider))
    const { ListObjectsV2Command } = BROWSER_S3_MODULE
    await client.send(new ListObjectsV2Command({ Bucket: 'b' }))

    expect(calls[0]?.opts).toEqual({ listPrefix: '' })
  })

  it('PUT sends body + Content-Type, returns {} on success', async () => {
    const { provider, calls } = makeProvider(() => 'https://signed/put')
    fetchHandle = installFetch(() => new Response('', { status: 200 }))

    const client = createBrowserS3Client(cfg(provider))
    const { PutObjectCommand } = BROWSER_S3_MODULE
    const body = new Uint8Array([1, 2, 3])
    const resp = await client.send(
      new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: body, ContentType: 'text/plain' }),
    )

    expect(calls[0]?.op).toBe('PUT')
    expect(calls[0]?.opts).toEqual({ contentType: 'text/plain' })
    expect(fetchHandle.calls[0]?.init?.method).toBe('PUT')
    const headers = fetchHandle.calls[0]?.init?.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('text/plain')
    expect(fetchHandle.calls[0]?.init?.body).toBe(body)
    expect(resp).toEqual({})
  })

  it('PUT falls back to config.defaultContentType, then to octet-stream', async () => {
    const { provider } = makeProvider(() => 'https://signed/put')
    fetchHandle = installFetch(() => new Response('', { status: 200 }))

    const client = createBrowserS3Client({
      bucket: 'b',
      presignedUrlProvider: provider,
      defaultContentType: 'application/json',
    })
    const { PutObjectCommand } = BROWSER_S3_MODULE
    await client.send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: new Uint8Array() }))
    const headers = fetchHandle.calls[0]?.init?.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')

    const { provider: p2 } = makeProvider(() => 'https://signed/put')
    const handle2 = installFetch(() => new Response('', { status: 200 }))
    const client2 = createBrowserS3Client(cfg(p2))
    await client2.send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: new Uint8Array() }))
    const h2 = handle2.calls[0]?.init?.headers as Record<string, string>
    expect(h2['Content-Type']).toBe('application/octet-stream')
    handle2.restore()
  })

  it('PUT propagates non-ok status as an Error with the status code', async () => {
    const { provider } = makeProvider(() => 'https://signed/put')
    fetchHandle = installFetch(
      () => new Response('bucket is read-only', { status: 403, statusText: 'Forbidden' }),
    )

    const client = createBrowserS3Client(cfg(provider))
    const { PutObjectCommand } = BROWSER_S3_MODULE
    await expect(
      client.send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: new Uint8Array() })),
    ).rejects.toThrow(/403.*Forbidden/)
  })

  it('DELETE single object', async () => {
    const { provider, calls } = makeProvider(() => 'https://signed/del')
    fetchHandle = installFetch(() => new Response(null, { status: 204 }))

    const client = createBrowserS3Client(cfg(provider))
    const { DeleteObjectCommand } = BROWSER_S3_MODULE
    await client.send(new DeleteObjectCommand({ Bucket: 'b', Key: 'doomed.txt' }))

    expect(calls[0]).toEqual({ path: '/doomed.txt', op: 'DELETE' })
    expect(fetchHandle.calls[0]?.init?.method).toBe('DELETE')
  })

  it('DELETE tolerates 404 silently (object already gone)', async () => {
    const { provider } = makeProvider(() => 'https://signed/del')
    fetchHandle = installFetch(() => new Response('', { status: 404 }))

    const client = createBrowserS3Client(cfg(provider))
    const { DeleteObjectCommand } = BROWSER_S3_MODULE
    await expect(
      client.send(new DeleteObjectCommand({ Bucket: 'b', Key: 'gone' })),
    ).resolves.toEqual({})
  })

  it('DeleteObjects fans out to one DELETE per key', async () => {
    const { provider, calls } = makeProvider((path) => `https://signed${path}`)
    fetchHandle = installFetch(() => new Response(null, { status: 204 }))

    const client = createBrowserS3Client(cfg(provider))
    const { DeleteObjectsCommand } = BROWSER_S3_MODULE
    const resp = await client.send(
      new DeleteObjectsCommand({
        Bucket: 'b',
        Delete: { Objects: [{ Key: 'a' }, { Key: 'b/c' }] },
      }),
    )

    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.path).sort()).toEqual(['/a', '/b/c'])
    expect(fetchHandle.calls.every((c) => c.init?.method === 'DELETE')).toBe(true)
    expect(resp).toEqual({ Deleted: [{ Key: 'a' }, { Key: 'b/c' }] })
  })

  it('COPY signs with copySource and sends x-amz-copy-source header', async () => {
    const { provider, calls } = makeProvider(() => 'https://signed/copy')
    fetchHandle = installFetch(() => new Response('', { status: 200 }))

    const client = createBrowserS3Client(cfg(provider))
    const { CopyObjectCommand } = BROWSER_S3_MODULE
    await client.send(
      new CopyObjectCommand({
        Bucket: 'b',
        Key: 'dst/new.txt',
        CopySource: 'b/src/old.txt',
      }),
    )

    expect(calls[0]?.op).toBe('COPY')
    expect(calls[0]?.opts).toEqual({ copySource: 'src/old.txt' })
    const headers = fetchHandle.calls[0]?.init?.headers as Record<string, string>
    expect(headers['x-amz-copy-source']).toBe('/src/old.txt')
  })

  it('rejects a non-browser command with a helpful error', async () => {
    const { provider } = makeProvider(() => 'https://signed/x')
    fetchHandle = installFetch(() => new Response(''))

    const client = createBrowserS3Client(cfg(provider))
    await expect(client.send({ input: { Bucket: 'b', Key: 'k' } } as unknown)).rejects.toThrow(
      /non-browser S3 command/,
    )
  })
})

describe('createBrowserS3Client — config validation', () => {
  it('throws when presignedUrlProvider is missing', () => {
    expect(() => createBrowserS3Client({ bucket: 'b' })).toThrow(/presignedUrlProvider/)
  })
})

describe('LIST XML parser edge cases', () => {
  let fetchHandle: ReturnType<typeof installFetch>
  beforeEach(() => {
    const { provider } = makeProvider(() => 'https://signed/list')
    fetchHandle = installFetch(() => new Response('', { status: 200 }))
    // parser is exercised via the LIST dispatch path; keep provider + fetch handy
    void provider
  })
  afterEach(() => {
    fetchHandle.restore()
  })

  async function parseList(xml: string): Promise<Record<string, unknown>> {
    const { provider } = makeProvider(() => 'https://signed/list')
    fetchHandle.restore()
    fetchHandle = installFetch(() => new Response(xml, { status: 200 }))
    const client = createBrowserS3Client(cfg(provider))
    const { ListObjectsV2Command } = BROWSER_S3_MODULE
    return client.send(new ListObjectsV2Command({ Bucket: 'b' }))
  }

  it('empty listing', async () => {
    const r = await parseList('<ListBucketResult></ListBucketResult>')
    expect(r.CommonPrefixes).toEqual([])
    expect(r.Contents).toEqual([])
    expect(r.IsTruncated).toBe(false)
    expect(r.NextContinuationToken).toBeUndefined()
  })

  it('decodes XML entities in Keys and Prefixes', async () => {
    const xml = `<ListBucketResult>
      <CommonPrefixes><Prefix>a&amp;b/</Prefix></CommonPrefixes>
      <Contents><Key>path &lt;x&gt;.txt</Key><Size>0</Size></Contents>
    </ListBucketResult>`
    const r = await parseList(xml)
    expect(r.CommonPrefixes).toEqual([{ Prefix: 'a&b/' }])
    expect((r.Contents as { Key: string }[])[0]?.Key).toBe('path <x>.txt')
  })

  it('handles missing Size gracefully (treats as 0)', async () => {
    const xml = `<ListBucketResult>
      <Contents><Key>no-size</Key></Contents>
    </ListBucketResult>`
    const r = await parseList(xml)
    expect((r.Contents as { Size: number }[])[0]?.Size).toBe(0)
  })
})
