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

import { PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeHfOperator, installFakeOperator } from '../../core/hf/mock.ts'
import { HfBucketsVFS } from '../hf_buckets/hf_buckets.ts'
import { HfModelsVFS } from './hf_models.ts'

// find_flat, du_size and du_entries are deliberately absent: the Hub's
// listing is recursive, so one paged fetch is the whole tree and the generic
// walk over it costs no requests. A native op would buy a constant factor and
// cost a second implementation of the same traversal.
const PY_OPS = ['read_bytes', 'readdir', 'stat', 'read_stream', 'range_read', 'exists']

// The mount is read-only, so the byte-mutation ops are absent here exactly as
// they are in python's `_OPS`. This list is the op-dispatcher channel, which a
// shell command bypasses: it answers `dispatch('write', ...)` and the FUSE
// adapter, so asserting the absence here is what keeps the two channels
// agreeing. See commands/builtin/hf_hub/io.ts for why a Hub write belongs to
// the `hf` CLI rather than to a POSIX write.
const PY_ABSENT_OPS = ['write', 'create', 'unlink', 'rm_r', 'mkdir']

function treePage(rows: unknown[]): Response {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HfModelsVFS', () => {
  it('exposes the python-parity ops map and flags', () => {
    const vfs = new HfModelsVFS({ repoId: 'ns/model' })
    expect(Object.keys(vfs.opsMap).sort()).toEqual([...PY_OPS].sort())
    for (const op of PY_ABSENT_OPS) expect(vfs.opsMap[op]).toBeUndefined()
    expect(vfs.kind).toBe('hf_models')
    expect(vfs.cachesReads).toBe(true)
    expect(vfs.supportsSnapshot).toBe(true)
    const optional = vfs as unknown as Record<string, unknown>
    expect(optional.rename).toBeUndefined()
    expect(optional.copy).toBeUndefined()
    expect(optional.truncate).toBeUndefined()
    expect(optional.rmdir).toBeUndefined()
    expect(optional.writeFile).toBeUndefined()
    expect(optional.mkdir).toBeUndefined()
    expect(optional.unlink).toBeUndefined()
  })

  it('redacts the token in state', async () => {
    const vfs = new HfModelsVFS({ repoId: 'ns/model', token: 'hf_tok' })
    const state = await vfs.getState()
    expect(state.type).toBe('hf_models')
    expect(state.config.token).toBe('<REDACTED>')
    expect(state.config.repoId).toBe('ns/model')
  })

  it('rejects a repo id the Hub cannot read, and only that', () => {
    // A BARE name is legal: the Hub resolves it against whoever the token
    // belongs to, and `hf repo create widget` then `hf download widget` is what
    // the real CLI produces. What is refused is a shape with no reading at all.
    for (const bad of ['a/b/c', 'ns/', '/name', '']) {
      expect(() => new HfModelsVFS({ repoId: bad })).toThrow(/namespace\/name/)
    }
    expect(new HfModelsVFS({ repoId: 'widget' }).config.repoId).toBe('widget')
  })

  it('addresses a model at the bare repo id, not under a plural segment', async () => {
    const vfs = new HfModelsVFS({ repoId: 'ns/model' })
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        urls.push(url)
        if (url.includes('/api/models/')) {
          return Promise.resolve(
            treePage([{ type: 'file', oid: 'abc', size: 2, path: 'config.json' }]),
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    )
    const data = await vfs.readFile(PathSpec.fromStrPath('/config.json'))
    expect(new TextDecoder().decode(data)).toBe('{}')
    expect(urls.some((u) => u.includes('/api/models/ns/model/tree/main'))).toBe(true)
    // A model's content hangs off the bare repo id; datasets and spaces sit
    // under their own segment, and reusing the API's plural here 404s.
    expect(urls.some((u) => u.includes('/ns/model/resolve/main/config.json'))).toBe(true)
  })

  it('reports the LFS object size, never the pointer size', async () => {
    const vfs = new HfModelsVFS({ repoId: 'ns/model' })
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          treePage([
            {
              type: 'file',
              oid: 'abc',
              size: 4798702184,
              path: 'model.safetensors',
              lfs: { oid: 'sha', size: 4798702184, pointerSize: 135 },
            },
          ]),
        ),
      ),
    )
    const stat = await vfs.stat(PathSpec.fromStrPath('/model.safetensors'))
    expect(stat.size).toBe(4798702184)
    expect(stat.extra.lfs_oid).toBe('sha')
  })
})

describe('HfBucketsVFS', () => {
  it('uses the bucket field and normalizes keyPrefix', () => {
    const vfs = new HfBucketsVFS({ bucket: 'ns/store', keyPrefix: '/lead/' })
    expect(vfs.kind).toBe('hf_buckets')
    expect(vfs.config.keyPrefix).toBe('lead/')
    expect(vfs.accessor.bucketUri).toBe('hf://buckets/ns/store')
    installFakeOperator(vfs.accessor, fakeHfOperator({ 'config.json': '{}' }))
  })
})
