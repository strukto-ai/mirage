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

import { stripSlash } from '../../utils/slash.ts'
import { describe, expect, it } from 'vitest'
import { GitHubCIAccessor } from '../../accessor/github_ci.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { FileType, PathSpec } from '../../types.ts'
import type { CITransport } from './_client.ts'
import { stat } from './stat.ts'

class NoopTransport implements CITransport {
  get(): Promise<unknown> {
    throw new Error('should not be called')
  }
  getBytes(): Promise<Uint8Array> {
    throw new Error('should not be called')
  }
  getPaginated(): Promise<unknown[]> {
    throw new Error('should not be called')
  }
}

function accessor(): GitHubCIAccessor {
  return new GitHubCIAccessor({ transport: new NoopTransport(), owner: 'o', repo: 'r' })
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: stripSlash(virtual) })
}

describe('github_ci stat modified', () => {
  it('returns modified from the cached run entry', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.put(
      '/runs/CI__123',
      new IndexEntry({
        id: '123',
        name: 'CI',
        resourceType: 'ci/run',
        remoteTime: '2026-04-05T00:00:00Z',
        vfsName: 'CI__123',
      }),
    )
    const s = await stat(accessor(), spec('/runs/CI__123'), idx)
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.extra.run_id).toBe('123')
    expect(s.modified).toBe('2026-04-05T00:00:00Z')
  })
})

describe('github_ci stat parent-listing failures', () => {
  class FailingTransport implements CITransport {
    constructor(private readonly err: Error) {}
    get(): Promise<unknown> {
      return Promise.reject(this.err)
    }
    getBytes(): Promise<Uint8Array> {
      return Promise.reject(this.err)
    }
    getPaginated(): Promise<unknown[]> {
      return Promise.reject(this.err)
    }
  }

  function failingAccessor(err: Error): GitHubCIAccessor {
    return new GitHubCIAccessor({ transport: new FailingTransport(err), owner: 'o', repo: 'r' })
  }

  it('propagates a backend failure instead of reporting ENOENT', async () => {
    const boom = Object.assign(new Error('403 rate limit exceeded'), { status: 403 })
    await expect(
      stat(failingAccessor(boom), spec('/runs/CI__123'), new RAMIndexCacheStore()),
    ).rejects.toThrow('403 rate limit exceeded')
  })

  it('still reports ENOENT when the parent is genuinely missing', async () => {
    const gone = Object.assign(new Error('/runs'), { code: 'ENOENT' })
    await expect(
      stat(failingAccessor(gone), spec('/runs/CI__123'), new RAMIndexCacheStore()),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
