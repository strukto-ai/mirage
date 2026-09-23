import { describe, expect, it } from 'vitest'
import type { S3Config } from '../../vfs/s3/config.ts'
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
