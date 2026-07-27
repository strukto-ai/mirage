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

import { PathSpec } from '@struktoai/mirage-core'
import { describe, expect, it } from 'vitest'
import { fakeHfOperator, installFakeOperator } from '../../core/hf/mock.ts'
import { HfBucketsResource } from '../hf_buckets/hf_buckets.ts'
import { HfModelsResource } from './hf_models.ts'

const PY_OPS = [
  'read_bytes',
  'readdir',
  'stat',
  'read_stream',
  'range_read',
  'du_size',
  'du_entries',
  'exists',
  'find_flat',
  'write',
  'create',
  'unlink',
  'mkdir',
]

describe('HfModelsResource', () => {
  it('exposes the python-parity ops map and flags', () => {
    const resource = new HfModelsResource({ repoId: 'ns/model' })
    expect(Object.keys(resource.opsMap).sort()).toEqual([...PY_OPS].sort())
    expect(resource.kind).toBe('hf_models')
    expect(resource.cachesReads).toBe(true)
    expect(resource.supportsSnapshot).toBe(true)
    const optional = resource as unknown as Record<string, unknown>
    expect(optional.rename).toBeUndefined()
    expect(optional.copy).toBeUndefined()
    expect(optional.truncate).toBeUndefined()
    expect(optional.rmdir).toBeUndefined()
  })

  it('redacts the token in state', async () => {
    const resource = new HfModelsResource({ repoId: 'ns/model', token: 'hf_tok' })
    const state = await resource.getState()
    expect(state.type).toBe('hf_models')
    expect(state.config.token).toBe('<REDACTED>')
    expect(state.config.repoId).toBe('ns/model')
  })

  it('rejects malformed repo ids', () => {
    expect(() => new HfModelsResource({ repoId: 'nope' })).toThrow(/namespace\/name/)
  })

  it('reads through the resource facade', async () => {
    const resource = new HfModelsResource({ repoId: 'ns/model' })
    installFakeOperator(resource.accessor, fakeHfOperator({ 'config.json': '{}' }))
    const data = await resource.readFile(PathSpec.fromStrPath('/config.json'))
    expect(new TextDecoder().decode(data)).toBe('{}')
    expect(await resource.exists(PathSpec.fromStrPath('/config.json'))).toBe(true)
  })
})

describe('HfBucketsResource', () => {
  it('uses the bucket field and normalizes keyPrefix', () => {
    const resource = new HfBucketsResource({ bucket: 'ns/store', keyPrefix: '/lead/' })
    expect(resource.kind).toBe('hf_buckets')
    expect(resource.config.keyPrefix).toBe('lead/')
    expect(resource.accessor.bucketUri).toBe('hf://buckets/ns/store')
  })
})
