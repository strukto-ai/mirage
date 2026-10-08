import { describe, expect, it } from 'vitest'
import { ConditionLost } from '../object_store/driver.ts'
import type { S3Config } from '../../vfs/s3/config.ts'
import { LOST_CODES, sdkError } from './_test_util.ts'
import type { S3Module } from './client.ts'
import { DRIVER, type S3Conn } from './driver.ts'

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
      if (c.lost) await expect(put).rejects.toBeInstanceOf(ConditionLost)
      else await expect(put).rejects.toBe(err)
    },
  )
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
