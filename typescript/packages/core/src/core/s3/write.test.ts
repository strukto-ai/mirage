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

import { S3Accessor } from '../../accessor/s3.ts'
import { runWithCacheManager } from '../../cache/context.ts'
import type { S3Config } from '../../vfs/s3/config.ts'
import { PathSpec } from '../../types.ts'
import * as clientMod from './client.ts'
import { write } from './write.ts'

class FakeManager {
  listingTrusted(_folder: string): boolean {
    return false
  }

  probedStat(): null {
    return null
  }

  readThrough(_path: PathSpec, fetch: () => Promise<Uint8Array>): Promise<Uint8Array> {
    return fetch()
  }

  writes: string[] = []
  ancestors: string[] = []

  invalidateAfterWrite(path: PathSpec): Promise<void> {
    this.writes.push(path.mountPath)
    return Promise.resolve()
  }

  invalidateAfterUnlink(_path: PathSpec): Promise<void> {
    return Promise.resolve()
  }

  invalidateAncestors(path: PathSpec): Promise<void> {
    this.ancestors.push(path.virtual)
    return Promise.resolve()
  }

  invalidateAfterMove(path: PathSpec, folder: boolean): Promise<void> {
    return folder ? this.invalidateSubtree(path) : this.invalidateAfterUnlink(path)
  }

  invalidateSubtree(_path: PathSpec): Promise<void> {
    return Promise.resolve()
  }

  cachedBytes(_path: PathSpec): Promise<Uint8Array | null> {
    return Promise.resolve(null)
  }

  cachedSize(_path: PathSpec): Promise<number | null> {
    return Promise.resolve(null)
  }
}

class FakeCommand {
  constructor(readonly input: { Key?: string; ContentType?: string }) {}
}

function mockPut(keys: string[], types: (string | undefined)[] = []): void {
  vi.mocked(clientMod.loadS3Module).mockResolvedValue({
    PutObjectCommand: FakeCommand,
  } as never)
  vi.mocked(clientMod.createS3Client).mockResolvedValue({
    send: (command: FakeCommand) => {
      keys.push(command.input.Key ?? '')
      types.push(command.input.ContentType)
      return Promise.resolve({})
    },
  } as never)
}

async function runWrite(
  mountPath: string,
  config: Partial<S3Config> = {},
): Promise<{ manager: FakeManager; keys: string[]; types: (string | undefined)[] }> {
  const keys: string[] = []
  const types: (string | undefined)[] = []
  mockPut(keys, types)
  const manager = new FakeManager()
  const accessor = new S3Accessor({ bucket: 'b', ...config } as S3Config)
  const spec = new PathSpec({
    vfsPath: mountPath.replace(/^\//, ''),
    virtual: `/mnt${mountPath}`,
    directory: '/mnt/',
  })
  await runWithCacheManager(manager, async () => {
    await write(accessor, spec, new TextEncoder().encode('hi'))
  })
  return { manager, keys, types }
}

describe('s3 core write', () => {
  beforeEach(() => {
    vi.mocked(clientMod.loadS3Module).mockReset()
    vi.mocked(clientMod.createS3Client).mockReset()
  })

  it('invalidates every ancestor listing', async () => {
    const { manager, keys } = await runWrite('/a/b/c.txt')
    expect(keys).toEqual(['a/b/c.txt'])
    // The put materializes `a` and `a/b` too, so their listings are stale.
    expect(manager.writes).toEqual(['/a/b/c.txt'])
    expect(manager.ancestors).toEqual(['/mnt/a/b/c.txt'])
  })

  it('invalidates only itself at the mount root', async () => {
    const { manager } = await runWrite('/c.txt')
    expect(manager.writes).toEqual(['/c.txt'])
  })

  it.each([
    [{}, undefined],
    [{ defaultContentType: 'text/plain' }, 'text/plain'],
  ])('with %j sends content type %s', async (config, type) => {
    const { types } = await runWrite('/c.txt', config)
    expect(types).toEqual([type])
  })
})
