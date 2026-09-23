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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return { ...actual, loadS3Module: vi.fn(), createS3Client: vi.fn() }
})

import type { S3Config } from '../../vfs/s3/config.ts'
import { S3Accessor } from '../../accessor/s3.ts'
import { PathSpec } from '../../types.ts'
import * as clientMod from './client.ts'
import { readdir } from './readdir.ts'

class ListCmd {
  constructor(readonly input: Record<string, unknown>) {}
}

class HeadCmd {
  constructor(readonly input: Record<string, unknown>) {}
}

const TREE = ['a.txt', 'dir/f.txt', 'dir/sub/g.txt', 'empty/']

function listing(keys: string[], prefix: string): Record<string, unknown> {
  const contents: { Key: string; Size: number }[] = []
  const common = new Set<string>()
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue
    const rel = key.slice(prefix.length)
    if (rel === '') {
      contents.push({ Key: key, Size: 0 })
    } else if (rel.includes('/')) {
      common.add(`${prefix}${rel.slice(0, rel.indexOf('/'))}/`)
    } else {
      contents.push({ Key: key, Size: 1 })
    }
  }
  return {
    CommonPrefixes: [...common].sort().map((Prefix) => ({ Prefix })),
    Contents: contents,
    IsTruncated: false,
  }
}

function notFound(): Error {
  const err = new Error('NotFound')
  err.name = 'NotFound'
  return err
}

function mockBucket(keys: string[]): void {
  vi.mocked(clientMod.loadS3Module).mockResolvedValue({
    ListObjectsV2Command: ListCmd,
    HeadObjectCommand: HeadCmd,
  } as never)
  vi.mocked(clientMod.createS3Client).mockResolvedValue({
    send: (cmd: unknown) => {
      if (cmd instanceof HeadCmd) {
        if (!keys.includes(cmd.input.Key as string)) throw notFound()
        return Promise.resolve({ ContentLength: 1 })
      }
      return Promise.resolve(listing(keys, (cmd as ListCmd).input.Prefix as string))
    },
  } as never)
}

function spec(virtual: string): PathSpec {
  return new PathSpec({
    vfsPath: virtual.replace(/^\/+|\/+$/g, ''),
    virtual,
    directory: virtual,
  })
}

function run(keys: string[], virtual: string, keyPrefix?: string): Promise<string[]> {
  mockBucket(keys)
  const config = { bucket: 'b', keyPrefix } as S3Config
  return readdir(new S3Accessor(config), spec(virtual))
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    return (err as { code?: string }).code ?? 'no-code'
  }
  return 'no-throw'
}

describe('s3 core readdir', () => {
  beforeEach(() => {
    vi.mocked(clientMod.loadS3Module).mockReset()
    vi.mocked(clientMod.createS3Client).mockReset()
  })

  it('lists a prefix', async () => {
    await expect(run(TREE, '/dir')).resolves.toEqual(['/dir/f.txt', '/dir/sub'])
  })

  it('reads a marker-only directory as empty, not missing', async () => {
    // The zero-byte "empty/" object is the only trace an empty directory
    // leaves, and it must read as an empty listing rather than ENOENT.
    await expect(run(TREE, '/empty')).resolves.toEqual([])
  })

  it('does not raise on the root of an empty bucket', async () => {
    await expect(run([], '/')).resolves.toEqual([])
  })

  it('reports ENOENT for a missing path', async () => {
    await expect(codeOf(run(TREE, '/never.txt'))).resolves.toBe('ENOENT')
  })

  it('reports ENOENT for a missing nested path', async () => {
    await expect(codeOf(run(TREE, '/nodir/deep'))).resolves.toBe('ENOENT')
  })

  it('reports ENOTDIR on an object', async () => {
    await expect(codeOf(run(TREE, '/a.txt'))).resolves.toBe('ENOTDIR')
  })

  it('reports ENOTDIR below an object', async () => {
    await expect(codeOf(run(TREE, '/a.txt/x'))).resolves.toBe('ENOTDIR')
  })

  it('reports ENOENT for a missing path under a key prefix', async () => {
    await expect(codeOf(run(['team/dir/f.txt'], '/never.txt', 'team'))).resolves.toBe('ENOENT')
  })

  it('does not raise on the root of an empty key-prefixed mount', async () => {
    await expect(run([], '/', 'team')).resolves.toEqual([])
  })

  it('reports ENOENT for a missing child of a coexisting object and prefix', async () => {
    // S3 allows an object "a" and a prefix "a/" at once, and a child path
    // reaches "a" only through the prefix, so a missing child is ENOENT.
    await expect(codeOf(run(['a', 'a/x.txt'], '/a/never'))).resolves.toBe('ENOENT')
  })

  it('still lists the children of a coexisting prefix', async () => {
    await expect(run(['a', 'a/x.txt'], '/a')).resolves.toEqual(['/a/x.txt'])
  })
})
