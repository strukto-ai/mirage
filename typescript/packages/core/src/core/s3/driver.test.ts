import { runWithCaller, currentCaller } from '../../context/session_context.ts'
import { readFileSync } from 'node:fs'
import { ABSENT_WRITE, ANY_WRITE } from '../../cache/types.ts'
import { describe, expect, it, vi } from 'vitest'
import { ConditionLostError } from '../object_store/errors.ts'
import { requireHook } from '../object_store/driver.ts'
import type { S3Config } from '../../vfs/s3/config.ts'
import { LOST_CODES, sdkError } from '../../../tests/core/s3/_test_util.ts'
import type { S3Module } from './types.ts'
import { MAX_PARTS, PART_DOUBLING } from './constants.ts'
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
      const put = DRIVER.putIf?.(conn, 'k', new Uint8Array([1]), { kind: 'match', version: 'v1' })
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
    await expect(
      DRIVER.copyIf?.(conn, 'src', 'dst', { kind: 'match', version: 'v1' }),
    ).rejects.toBe(err)
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
    await expect(
      DRIVER.copyIf?.(conn, 'src', 'dst', { kind: 'match', version: 'v1' }),
    ).rejects.toBe(missing)
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
        kind: 'match',
        version: 'old',
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

  it('sends each part as its bytes stood when it went', async () => {
    const base = uploadConnection([])
    const bodies: Uint8Array[] = []
    const conn: S3Conn = {
      ...base,
      async send(raw) {
        if (raw instanceof UploadPart) bodies.push((raw.input.Body as Uint8Array).slice())
        return base.send(raw)
      },
    }
    const part = 8 * 1024 * 1024
    const data = Uint8Array.from({ length: 2 * part + 37 }, (_, i) => i % 251)
    async function* source(): AsyncGenerator<Uint8Array> {
      await Promise.resolve()
      for (let offset = 0; offset < data.length; offset += 65521)
        yield data.slice(offset, offset + 65521)
    }
    await DRIVER.putStream?.(conn, 'k', source(), ANY_WRITE)
    expect(bodies.map((body) => body.length)).toEqual([part, part, 37])
    expect(Buffer.compare(Buffer.concat(bodies), data)).toBe(0)
  })

  it('doubles its parts past the part cap', async () => {
    vi.resetModules()
    vi.doMock('./constants.ts', async (original) => ({
      ...(await original<Record<string, unknown>>()),
      PART_SIZE: 16,
    }))
    try {
      const { DRIVER: small } = await import('./driver.ts')
      const sent: Command[] = []
      const size = MAX_PARTS * 16 + 1
      async function* source(): AsyncGenerator<Uint8Array> {
        await Promise.resolve()
        for (let offset = 0; offset < size; offset += 16)
          yield new Uint8Array(Math.min(16, size - offset))
      }
      const result = await small.putStream?.(uploadConnection(sent), 'k', source(), ANY_WRITE)
      const sizes = sent
        .filter((c) => c instanceof UploadPart)
        .map((c) => (c.input.Body as Uint8Array).length)
      expect(result?.size).toBe(size)
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(size)
      expect(sizes.slice(0, 2 * PART_DOUBLING)).toEqual([
        ...Array<number>(PART_DOUBLING).fill(16),
        ...Array<number>(PART_DOUBLING).fill(32),
      ])
      expect(sizes.length).toBeLessThan(MAX_PARTS)
    } finally {
      vi.doUnmock('./constants.ts')
      vi.resetModules()
    }
  })

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
      DRIVER.putStream?.(uploadConnection(sent, failure), 'k', source(), {
        kind: 'match',
        version: 'old',
      }),
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
    kind === 'presigned' ? { kind: 'any' } : { kind: 'match', version: 'old' },
  )
  expect(result?.size).toBe(data.length)
  expect(sent).toHaveLength(1)
  expect(sent[0]?.constructor).toBe(Command)
  if (kind === 'custom') expect(sent[0]?.input.IfMatch).toBe('"old"')
})

it.each([13, 8 * 1024 * 1024 + 37])(
  'conditions the final streamed creation for %s bytes',
  async (size) => {
    const sent: Command[] = []
    const body = new Uint8Array(size)
    const result = await DRIVER.putStream?.(uploadConnection(sent), 'k', body, ABSENT_WRITE)
    expect(result?.size).toBe(size)
    expect(sent.at(-1)?.input.IfNoneMatch).toBe('*')
    expect(sent.at(-1)?.input.IfMatch).toBeUndefined()
  },
)

it('refuses protected presigned uploads before sending a request', async () => {
  const sent: Command[] = []
  const base = uploadConnection(sent)
  const conn = {
    ...base,
    config: {
      ...base.config,
      presignedUrlProvider: () => Promise.resolve('https://store.invalid/object'),
    },
  }
  await expect(
    DRIVER.putStream?.(conn, 'k', new Uint8Array([1]), ABSENT_WRITE),
  ).rejects.toMatchObject({ code: 'ENOTSUP' })
  expect(sent).toEqual([])
})

interface MoveRecoveryCase {
  name: string
  initial?: string
  replacement?: string
  cleanup_code?: string
  source_code?: string
  no_etag?: boolean
  etag?: string
  version?: string
  retries?: number
  copy_retries?: number
  recovered: boolean
  destination: string | null
  deletes: number
}

const MOVE_RECOVERY = JSON.parse(
  readFileSync(
    new URL('../../../../../../integ/fixtures/write/move_recovery.json', import.meta.url),
    'utf8',
  ),
) as { cases: MoveRecoveryCase[] }

class MoveHead {
  constructor(readonly input: Record<string, unknown>) {}
}
class MoveCopy {
  constructor(readonly input: Record<string, unknown>) {}
}
class MoveDelete {
  constructor(readonly input: Record<string, unknown>) {}
}

describe('a failed move compensates only its copy', () => {
  it.each(MOVE_RECOVERY.cases)('$name', async (c) => {
    const objects = new Map([['src', 'source']])
    if (c.initial !== undefined) objects.set('dst', c.initial)
    const calls: Record<string, unknown>[] = []
    const conn: S3Conn = {
      config: { bucket: 'b' } as S3Config,
      mod: {
        HeadObjectCommand: MoveHead,
        CopyObjectCommand: MoveCopy,
        DeleteObjectCommand: MoveDelete,
      } as unknown as S3Module,
      send(cmd: unknown): Promise<Record<string, unknown>> {
        const { input } = cmd as MoveHead
        if (cmd instanceof MoveHead) {
          const value = objects.get(input.Key as string)
          if (value === undefined) return Promise.reject(sdkError('NoSuchKey', 404))
          return Promise.resolve({
            ContentLength: 6,
            LastModified: new Date('2026-01-01'),
            ETag: `"${value}"`,
          })
        }
        if (cmd instanceof MoveCopy) {
          expect(input.CopySourceIfMatch).toBe('"source"')
          if (c.initial === undefined) expect(input.IfNoneMatch).toBe('*')
          objects.set('dst', 'copy')
          return Promise.resolve({
            CopyObjectResult: c.no_etag === true ? {} : { ETag: c.etag ?? '"copy"' },
            $metadata: { attempts: (c.copy_retries ?? 0) + 1 },
            ...(c.version !== undefined ? { VersionId: c.version } : {}),
          })
        }
        calls.push(input)
        if (input.Key === 'src') {
          const code = c.source_code ?? 'PreconditionFailed'
          if (code === 'NoSuchKey') objects.delete('src')
          else objects.set('src', 'new-source')
          const err = sdkError(
            code,
            code === 'NoSuchKey'
              ? 404
              : code === 'ConditionalRequestConflict'
                ? 409
                : code === 'AccessDenied'
                  ? 403
                  : 412,
          )
          Object.assign(err, {
            $metadata: {
              httpStatusCode:
                code === 'NoSuchKey'
                  ? 404
                  : code === 'ConditionalRequestConflict'
                    ? 409
                    : code === 'AccessDenied'
                      ? 403
                      : 412,
              attempts: (c.retries ?? 0) + 1,
            },
          })
          return Promise.reject(err)
        }
        if (c.replacement !== undefined) objects.set('dst', c.replacement)
        if (c.cleanup_code !== undefined) {
          if (c.cleanup_code === 'NoSuchKey') objects.delete('dst')
          return Promise.reject(
            sdkError(
              c.cleanup_code,
              c.cleanup_code === 'NoSuchKey'
                ? 404
                : c.cleanup_code === 'PreconditionFailed'
                  ? 412
                  : 403,
            ),
          )
        }
        if (c.version !== undefined) {
          expect(input.VersionId).toBe(c.version)
          expect(input.IfMatch).toBeUndefined()
          if (objects.get('dst') === 'copy') {
            if (c.initial === undefined) objects.delete('dst')
            else objects.set('dst', c.copy_retries === undefined ? c.initial : 'copy')
          }
        } else {
          expect(input.IfMatch).toBe('"copy"')
          objects.delete('dst')
        }
        return Promise.resolve({})
      },
    }
    let refusal: (ConditionLostError & { recovered: boolean; recoveryError: unknown }) | undefined
    try {
      await requireHook(DRIVER.moveFileIf)(conn, 'src', 'dst', ANY_WRITE, 'source')
    } catch (err) {
      if (c.source_code !== 'AccessDenied') expect(err).toBeInstanceOf(ConditionLostError)
      refusal = err as typeof refusal
    }
    expect(refusal).toBeDefined()
    expect(objects.get('dst') ?? null).toBe(c.destination)
    expect(calls).toHaveLength(c.deletes)
    expect(refusal?.recovered).toBe(c.recovered)
    if (c.cleanup_code !== undefined && !c.recovered) expect(refusal?.recoveryError).toBeTruthy()
  })
})

it('compensates cancellation after a confirmed copy before source deletion', async () => {
  const controller = new AbortController()
  const deleted: string[] = []
  const conn: S3Conn = {
    config: { bucket: 'b' } as S3Config,
    mod: { CopyObjectCommand: MoveCopy, DeleteObjectCommand: MoveDelete } as unknown as S3Module,
    send(cmd: unknown) {
      if (cmd instanceof MoveCopy) {
        controller.abort()
        return Promise.resolve({ CopyObjectResult: { ETag: '"copy"' } })
      }
      deleted.push((cmd as MoveDelete).input.Key as string)
      return Promise.resolve({})
    },
  }
  await expect(
    runWithCaller({ ...currentCaller(), stop: controller }, () =>
      requireHook(DRIVER.moveFileIf)(conn, 'src', 'dst', ABSENT_WRITE, 'source'),
    ),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(deleted).toEqual(['dst'])
})

it('does not require new destination read permissions for a move', async () => {
  const sent: Record<string, unknown>[] = []
  const conn: S3Conn = {
    config: { bucket: 'b' } as S3Config,
    mod: {
      HeadObjectCommand: MoveHead,
      CopyObjectCommand: MoveCopy,
      DeleteObjectCommand: MoveDelete,
    } as unknown as S3Module,
    send(cmd: unknown) {
      if (cmd instanceof MoveHead) return Promise.reject(sdkError('AccessDenied', 403))
      sent.push((cmd as MoveCopy).input)
      return Promise.resolve(
        cmd instanceof MoveCopy ? { CopyObjectResult: { ETag: '"copy"' } } : {},
      )
    },
  }
  await expect(
    requireHook(DRIVER.moveFileIf)(conn, 'src', 'dst', ANY_WRITE, 'source'),
  ).resolves.toBe(true)
  expect(sent[0]?.IfNoneMatch).toBeUndefined()
  expect(sent[1]?.Key).toBe('src')
})

it('keeps the abort result when cancellation arrives during compensation', async () => {
  const controller = new AbortController()
  let release!: () => void
  let started!: () => void
  const cleanupStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const objects = new Map([
    ['src', 'new-source'],
    ['dst', 'copy'],
  ])
  const conn: S3Conn = {
    config: { bucket: 'b' } as S3Config,
    mod: { CopyObjectCommand: MoveCopy, DeleteObjectCommand: MoveDelete } as unknown as S3Module,
    send(cmd: unknown) {
      if (cmd instanceof MoveCopy) return Promise.resolve({ CopyObjectResult: { ETag: '"copy"' } })
      if ((cmd as MoveDelete).input.Key === 'src')
        return Promise.reject(sdkError('PreconditionFailed', 412))
      started()
      return new Promise<Record<string, unknown>>((resolve) => {
        release = () => {
          objects.delete('dst')
          resolve({})
        }
      })
    },
  }
  const move = runWithCaller({ ...currentCaller(), stop: controller }, () =>
    requireHook(DRIVER.moveFileIf)(conn, 'src', 'dst', ABSENT_WRITE, 'source'),
  )
  const rejected = expect(move).rejects.toMatchObject({ name: 'AbortError' })
  await cleanupStarted
  controller.abort()
  release()
  await rejected
  expect(Object.fromEntries(objects)).toEqual({ src: 'new-source' })
})

it('bounds an unknown source delete and reports partial completion on cancellation', async () => {
  const controller = new AbortController()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  let started!: () => void
  const deletionStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const deleted: string[] = []
  const conn: S3Conn = {
    config: { bucket: 'b' } as S3Config,
    mod: { CopyObjectCommand: MoveCopy, DeleteObjectCommand: MoveDelete } as unknown as S3Module,
    send(cmd: unknown, options?: { abortSignal?: AbortSignal }) {
      if (cmd instanceof MoveCopy) return Promise.resolve({ CopyObjectResult: { ETag: '"copy"' } })
      deleted.push((cmd as MoveDelete).input.Key as string)
      started()
      return new Promise<Record<string, unknown>>((_resolve, reject) => {
        options?.abortSignal?.addEventListener(
          'abort',
          () => {
            reject(new DOMException('stopped', 'AbortError'))
          },
          { once: true },
        )
      })
    },
  }
  try {
    const move = runWithCaller({ ...currentCaller(), stop: controller }, () =>
      requireHook(DRIVER.moveFileIf)(conn, 'src', 'dst', ABSENT_WRITE, 'source'),
    )
    const rejected = expect(move).rejects.toMatchObject({ name: 'AbortError' })
    await deletionStarted
    controller.abort()
    await rejected
    expect(deleted).toEqual(['src'])
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('source deletion outcome unknown'))
  } finally {
    warning.mockRestore()
  }
})

it.each(['refused', 'committed'])(
  'joins a source delete that %s during cancellation',
  async (outcome) => {
    const controller = new AbortController()
    let started!: () => void
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      started = resolve
    })
    const objects = new Map([['src', 'original']])
    const deleted: string[] = []
    const conn: S3Conn = {
      config: { bucket: 'b' } as S3Config,
      mod: { CopyObjectCommand: MoveCopy, DeleteObjectCommand: MoveDelete } as unknown as S3Module,
      send(cmd: unknown) {
        if (cmd instanceof MoveCopy) {
          objects.set('dst', 'original')
          return Promise.resolve({ CopyObjectResult: { ETag: '"copy"' } })
        }
        const key = (cmd as MoveDelete).input.Key as string
        deleted.push(key)
        if (key === 'dst') {
          objects.delete('dst')
          return Promise.resolve({})
        }
        if (outcome === 'committed') objects.delete('src')
        else objects.set('src', 'new-source')
        started()
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          finish = () => {
            if (outcome === 'committed') resolve({})
            else reject(sdkError('PreconditionFailed', 412))
          }
        })
      },
    }
    const move = runWithCaller({ ...currentCaller(), stop: controller }, () =>
      requireHook(DRIVER.moveFileIf)(conn, 'src', 'dst', ABSENT_WRITE, 'source'),
    )
    const rejected = expect(move).rejects.toMatchObject({ name: 'AbortError' })
    await pending
    controller.abort()
    finish()
    await rejected
    expect(deleted).toEqual(outcome === 'committed' ? ['src'] : ['src', 'dst'])
    expect(Object.fromEntries(objects)).toEqual(
      outcome === 'committed' ? { dst: 'original' } : { src: 'new-source' },
    )
  },
)

it('competing destination creation names the destination', async () => {
  let heads = 0
  const conn: S3Conn = {
    config: { bucket: 'b' } as S3Config,
    mod: { HeadObjectCommand: MoveHead, CopyObjectCommand: MoveCopy } as unknown as S3Module,
    send(cmd: unknown): Promise<Record<string, unknown>> {
      if (cmd instanceof MoveHead) {
        if (heads++ === 0) return Promise.reject(sdkError('NoSuchKey', 404))
        return Promise.resolve({
          ContentLength: 6,
          LastModified: new Date('2026-01-01'),
          ETag: '"theirs"',
        })
      }
      expect(cmd).toBeInstanceOf(MoveCopy)
      return Promise.reject(sdkError('PreconditionFailed', 412))
    },
  }
  await expect(
    requireHook(DRIVER.moveFileIf)(conn, 'src', 'dst', { kind: 'any' }, 'source'),
  ).rejects.toMatchObject({ keys: ['dst'], gone: false })
})
