import { describe, expect, it } from 'vitest'
import { ConditionLostError } from '../object_store/errors.ts'
import type { S3Config } from '../../vfs/s3/config.ts'
import { LOST_CODES, sdkError } from '../../../tests/core/s3/_test_util.ts'
import type { S3Module } from './types.ts'
import { DRIVER } from './driver.ts'
import type { S3Conn } from './types.ts'

class Command {
  constructor(readonly input: Record<string, unknown>) {}
}

describe('S3 metadata timestamps', () => {
  it.each([
    ['2026-09-05T10:55:39.000Z', '2026-09-05T10:55:39Z'],
    ['2026-09-05T10:55:39.123Z', '2026-09-05T10:55:39.123000Z'],
  ])('HEAD and LIST agree with Python for %s', async (input, expected) => {
    const conn: S3Conn = {
      config: { bucket: 'b' } as S3Config,
      mod: { HeadObjectCommand: Command, ListObjectsV2Command: Command } as unknown as S3Module,
      send: () =>
        Promise.resolve({
          ContentLength: 2,
          LastModified: new Date(input),
          Contents: [{ Key: 'a.txt', Size: 2, LastModified: new Date(input) }],
        }),
    }
    expect((await DRIVER.head(conn, 'a.txt'))?.modified).toBe(expected)
    const children = []
    for await (const child of DRIVER.listChildren(conn, '')) children.push(child)
    expect(children).toEqual([{ key: 'a.txt', kind: 'f', size: 2, modified: expected }])
  })
})

function failing(send: (cmd: { input: Record<string, unknown> }) => Promise<never>): S3Conn {
  return {
    config: { bucket: 'b' } as S3Config,
    mod: {
      PutObjectCommand: Command,
      CopyObjectCommand: Command,
      HeadObjectCommand: Command,
    } as unknown as S3Module,
    send: (cmd: unknown) => send(cmd as { input: Record<string, unknown> }),
  }
}

describe('a write carrying If-Match', () => {
  it.each(LOST_CODES.matched.map((c) => [c.name, c] as const))(
    'loses only on its key: %s',
    async (_n, c) => {
      const err = Object.assign(new Error(c.code), {
        name: c.code,
        Code: c.code,
        $metadata: { httpStatusCode: c.status },
      })
      const conn = failing(() => Promise.reject(err))
      const put = DRIVER.putIf?.(conn, 'k', new Uint8Array([1]), { ifMatch: 'v1' })
      if (c.lost) await expect(put).rejects.toBeInstanceOf(ConditionLostError)
      else await expect(put).rejects.toBe(err)
    },
  )
})

describe('a missing pinned revision', () => {
  it.each([
    ['unpinned', null, 'NoSuchKey', true],
    ['pinned NoSuchVersion', 'rev', 'NoSuchVersion', false],
    ['pinned bodiless', 'rev', 'Unknown', false],
    ['pinned missing bucket', 'rev', 'NoSuchBucket', null],
  ] as const)('is no missing file: %s', async (_n, revision, code, missing) => {
    // A pin gone from the store fails the read; only an unpinned 404 is absence.
    const gone = Object.assign(new Error(code), {
      name: code,
      $metadata: { httpStatusCode: 404 },
    })
    const conn: S3Conn = {
      config: { bucket: 'b' } as S3Config,
      mod: { GetObjectCommand: Command } as unknown as S3Module,
      send: () => Promise.reject(gone),
    }
    const got = DRIVER.getVersioned?.(conn, 'k', revision)
    if (missing === true) await expect(got).resolves.toBeNull()
    else if (missing === false) await expect(got).rejects.toMatchObject({ code: 'ENOENT' })
    else await expect(got).rejects.toBe(gone)
  })
})

describe('a missing bucket', () => {
  it.each([
    ['by name', { name: 'NoSuchBucket' }],
    ['by Code', { name: 'Unknown', Code: 'NoSuchBucket' }],
  ] as const)('is never a lost condition, %s', async (_how, fields) => {
    const err = Object.assign(new Error('NoSuchBucket'), fields, {
      $metadata: { httpStatusCode: 404 },
    })
    const sent: string[] = []
    const conn = failing((cmd) => {
      sent.push(cmd.input.CopySource ? 'copy' : 'other')
      return Promise.reject(err)
    })
    await expect(DRIVER.copyIf?.(conn, 'src', 'dst', { ifMatch: 'v1' })).rejects.toBe(err)
    expect(sent).toEqual(['copy'])
  })
})

describe('a conditioned copy', () => {
  it.each([
    ['the source probe fails', 'AccessDenied', 403],
    ['the source is gone', 'NotFound', 404],
  ] as const)('keeps its own error when %s', async (_name, code, status) => {
    // The probe only decides which side a 404 names; it never stands in for it.
    const missing = sdkError('NoSuchKey', 404)
    const conn = failing((cmd) =>
      Promise.reject(cmd.input.CopySource !== undefined ? missing : sdkError(code, status)),
    )
    await expect(DRIVER.copyIf?.(conn, 'src', 'dst', { ifMatch: 'v1' })).rejects.toBe(missing)
  })
})

class CreateMultipart extends Command {}
class UploadPart extends Command {}
class CompleteMultipart extends Command {}
class AbortMultipart extends Command {}

function uploadConnection(sent: Command[], failure?: string): S3Conn {
  return {
    config: { bucket: 'b' } as S3Config,
    mod: {
      PutObjectCommand: Command,
      CreateMultipartUploadCommand: CreateMultipart,
      UploadPartCommand: UploadPart,
      CompleteMultipartUploadCommand: CompleteMultipart,
      AbortMultipartUploadCommand: AbortMultipart,
    } as unknown as S3Module,
    async send(raw) {
      await Promise.resolve()
      const cmd = raw as Command
      sent.push(cmd)
      if (cmd instanceof UploadPart && failure === 'part') throw new Error('upload failed')
      if (cmd instanceof CompleteMultipart && failure === 'condition')
        throw sdkError('PreconditionFailed', 412)
      if (cmd instanceof CreateMultipart) return { UploadId: 'upload' }
      return { ETag: '"etag"' }
    },
  }
}

describe('streamed uploads', () => {
  it.each([0, 13, 8 * 1024 * 1024, 8 * 1024 * 1024 + 37])(
    'bounds parts and preserves conditions for %s bytes',
    async (size) => {
      const sent: Command[] = []
      let closed = false
      async function* source(): AsyncGenerator<Uint8Array> {
        await Promise.resolve()
        try {
          for (let offset = 0; offset < size; offset += 65536)
            yield new Uint8Array(Math.min(65536, size - offset))
        } finally {
          closed = true
        }
      }
      const result = await DRIVER.putStream?.(uploadConnection(sent), 'k', source(), {
        ifMatch: 'old',
      })
      expect(result?.size).toBe(size)
      expect(closed).toBe(true)
      if (size < 8 * 1024 * 1024) {
        expect(sent).toHaveLength(1)
        expect(sent[0]?.input.IfMatch).toBe('"old"')
        expect((sent[0]?.input.Body as Uint8Array).length).toBe(size)
      } else {
        const sizes = sent
          .filter((c) => c instanceof UploadPart)
          .map((c) => (c.input.Body as Uint8Array).length)
        expect(sizes).toEqual(size % (8 * 1024 * 1024) ? [8 * 1024 * 1024, 37] : [8 * 1024 * 1024])
        expect(sent.find((c) => c instanceof CompleteMultipart)?.input.IfMatch).toBe('"old"')
      }
      expect(sent.some((c) => c instanceof AbortMultipart)).toBe(false)
    },
  )

  it.each(['source', 'part', 'condition', 'cancel'])('aborts after %s failure', async (failure) => {
    const sent: Command[] = []
    let closed = false
    async function* source(): AsyncGenerator<Uint8Array> {
      await Promise.resolve()
      try {
        yield new Uint8Array(8 * 1024 * 1024)
        if (failure === 'source') throw new Error('read failed')
        if (failure === 'cancel') throw new DOMException('Cancelled', 'AbortError')
      } finally {
        closed = true
      }
    }
    await expect(
      DRIVER.putStream?.(uploadConnection(sent, failure), 'k', source(), { ifMatch: 'old' }),
    ).rejects.toBeInstanceOf(Error)
    const aborted = sent.filter((c) => c instanceof AbortMultipart)
    expect(aborted.map((c) => c.input)).toEqual([{ Bucket: 'b', Key: 'k', UploadId: 'upload' }])
    expect(closed).toBe(true)
  })
})

it.each(['presigned', 'custom'])('keeps %s uploads on the single-PUT fallback', async (kind) => {
  const sent: Command[] = []
  const base = uploadConnection(sent)
  const config: S3Config = {
    ...base.config,
    ...(kind === 'presigned'
      ? { presignedUrlProvider: () => Promise.resolve('https://store.invalid/object') }
      : { endpoint: 'https://store.invalid' }),
  }
  const data = new Uint8Array(8 * 1024 * 1024)
  const result = await DRIVER.putStream?.(
    { ...base, config },
    'k',
    data,
    kind === 'presigned' ? {} : { ifMatch: 'old' },
  )
  expect(result?.size).toBe(data.length)
  expect(sent).toHaveLength(1)
  expect(sent[0]?.constructor).toBe(Command)
  if (kind === 'custom') expect(sent[0]?.input.IfMatch).toBe('"old"')
})
