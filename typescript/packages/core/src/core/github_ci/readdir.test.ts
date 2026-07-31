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
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import type { CITransport } from './_client.ts'
import { readdir } from './readdir.ts'
import { ciJsonBytes } from './render.ts'

class ListTransport implements CITransport {
  constructor(private readonly items: unknown[]) {}
  get(): Promise<unknown> {
    throw new Error('should not be called')
  }
  getBytes(): Promise<Uint8Array> {
    throw new Error('should not be called')
  }
  getPaginated(): Promise<unknown[]> {
    return Promise.resolve(this.items)
  }
}

function accessor(items: unknown[]): GitHubCIAccessor {
  return new GitHubCIAccessor({ transport: new ListTransport(items), owner: 'o', repo: 'r' })
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: stripSlash(virtual) })
}

describe('github_ci readdir sizes', () => {
  it('stores the rendered workflow size on the listing entry', async () => {
    const wf = { id: 7, name: 'CI', state: 'active', updated_at: '2026-01-01' }
    const idx = new RAMIndexCacheStore()
    await readdir(accessor([wf]), spec('/workflows'), idx)
    const lookup = await idx.get('/workflows/CI_7.json')
    expect(lookup.entry?.size).toBe(ciJsonBytes(wf).byteLength)
  })

  it('seeds the run dir with a sized run.json and unsized annotations', async () => {
    const run = { id: 11, name: 'CI', status: 'completed', updated_at: 'u' }
    const idx = new RAMIndexCacheStore()
    await readdir(accessor([run]), spec('/runs'), idx)
    const listing = await idx.listDir('/runs/CI_11')
    expect(listing.entries).toEqual([
      '/runs/CI_11/run.json',
      '/runs/CI_11/jobs',
      '/runs/CI_11/annotations.jsonl',
      '/runs/CI_11/artifacts',
    ])
    const runJson = await idx.get('/runs/CI_11/run.json')
    expect(runJson.entry?.size).toBe(ciJsonBytes(run).byteLength)
    const annotations = await idx.get('/runs/CI_11/annotations.jsonl')
    expect(annotations.entry?.size).toBeNull()
  })

  it('stores the rendered job size on the json entry only', async () => {
    const run = { id: 11, name: 'CI', updated_at: 'u' }
    const idx = new RAMIndexCacheStore()
    await readdir(accessor([run]), spec('/runs'), idx)
    const job = { id: 21, name: 'build', completed_at: 'c', steps: [] }
    await readdir(accessor([job]), spec('/runs/CI_11/jobs'), idx)
    const jsonLookup = await idx.get('/runs/CI_11/jobs/build_21.json')
    expect(jsonLookup.entry?.size).toBe(ciJsonBytes(job).byteLength)
    const logLookup = await idx.get('/runs/CI_11/jobs/build_21.log')
    expect(logLookup.entry?.size).toBeNull()
  })
})
