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

import { describe, expect, it } from 'vitest'
import { HF_ENDPOINT } from '../vfs/hf_buckets/config.ts'
import { HfBucketsAccessor, HfDatasetsAccessor, HfModelsAccessor, HfSpacesAccessor } from './hf.ts'

describe('HfAccessor.operatorOptions', () => {
  it('builds minimal options for a public model', () => {
    const accessor = new HfModelsAccessor({ repoId: 'ns/model' })
    expect(accessor.operatorOptions()).toEqual({
      repo_type: 'model',
      repo_id: 'ns/model',
    })
  })

  it('includes token, endpoint, root, and revision when configured', () => {
    const accessor = new HfDatasetsAccessor({
      repoId: 'ns/data',
      token: 'hf_tok',
      endpoint: 'https://hub.example.com',
      keyPrefix: 'sub/dir',
      revision: 'v1.0',
    })
    expect(accessor.operatorOptions()).toEqual({
      repo_type: 'dataset',
      repo_id: 'ns/data',
      token: 'hf_tok',
      endpoint: 'https://hub.example.com',
      root: '/sub/dir/',
      revision: 'v1.0',
    })
  })

  it('uses bucket as repo id for hf_buckets and never sets revision', () => {
    const accessor = new HfBucketsAccessor({ bucket: 'ns/store', keyPrefix: '/lead/trail/' })
    expect(accessor.operatorOptions()).toEqual({
      repo_type: 'bucket',
      repo_id: 'ns/store',
      root: '/lead/trail/',
    })
  })

  it('exposes python-parity bucket uris', () => {
    expect(new HfBucketsAccessor({ bucket: 'a/b' }).bucketUri).toBe('hf://buckets/a/b')
    expect(new HfDatasetsAccessor({ repoId: 'a/b' }).bucketUri).toBe('hf://datasets/a/b')
    expect(new HfModelsAccessor({ repoId: 'a/b' }).bucketUri).toBe('hf://models/a/b')
    expect(new HfSpacesAccessor({ repoId: 'a/b' }).bucketUri).toBe('hf://spaces/a/b')
  })

  it('reaches the Hub at the default endpoint unless one is configured', () => {
    // A partial override: the endpoint is the only field that changes.
    const plain = new HfBucketsAccessor({ bucket: 'ns/store', token: 't' })
    expect([plain.endpoint, plain.token]).toEqual([HF_ENDPOINT, 't'])
    const custom = new HfBucketsAccessor({ bucket: 'ns/store', endpoint: 'http://x' })
    expect([custom.endpoint, custom.token]).toEqual(['http://x', undefined])
  })

  it('applies the key prefix to a bucket path once', () => {
    // A directly built accessor gets keyPrefix unnormalised; the VFS is not
    // there to strip it.
    const accessor = new HfBucketsAccessor({ bucket: 'ns/store', keyPrefix: '/lead/trail/' })
    expect(accessor.bucketPath('a.txt')).toBe('lead/trail/a.txt')
    expect(accessor.bucketPath('/sub/a.txt')).toBe('lead/trail/sub/a.txt')
    expect(new HfBucketsAccessor({ bucket: 'ns/store' }).bucketPath('/a.txt')).toBe('a.txt')
    // opendal normalizes its root's empty segments away and the Hub matches
    // paths exactly, so the direct calls have to agree with the listing.
    expect(
      new HfBucketsAccessor({ bucket: 'ns/store', keyPrefix: 'a//b' }).bucketPath('/x.txt'),
    ).toBe('a/b/x.txt')
    expect(new HfBucketsAccessor({ bucket: 'ns/store', keyPrefix: '/' }).bucketPath('/x.txt')).toBe(
      'x.txt',
    )
  })

  it('builds a real opendal operator lazily and caches it', async () => {
    const accessor = new HfModelsAccessor({ repoId: 'ns/model' })
    const op = await accessor.operator()
    expect(op).toBe(await accessor.operator())
    expect(typeof op.read).toBe('function')
  })
})
