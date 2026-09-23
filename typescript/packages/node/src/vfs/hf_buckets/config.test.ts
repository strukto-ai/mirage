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
import {
  HF_ENDPOINT,
  normalizeHfBucketsConfig,
  normalizeHfRepoConfig,
  redactHfBucketsConfig,
  redactHfRepoConfig,
} from './config.ts'

describe('normalizeHfBucketsConfig', () => {
  it('accepts namespace/name buckets and renames snake_case fields', () => {
    const config = normalizeHfBucketsConfig({
      bucket: 'ns/data',
      token: 'hf_secret',
      key_prefix: 'sub/dir',
      timeout: 30,
    })
    expect(config.bucket).toBe('ns/data')
    expect(config.keyPrefix).toBe('sub/dir')
    expect(config.timeoutMs).toBe(30000)
  })

  it('rejects buckets without a namespace', () => {
    expect(() => normalizeHfBucketsConfig({ bucket: 'noslash' })).toThrow(/namespace\/name/)
    expect(() => normalizeHfBucketsConfig({ bucket: 'a/b/c' })).toThrow(/namespace\/name/)
    expect(() => normalizeHfBucketsConfig({ bucket: '/b' })).toThrow(/namespace\/name/)
    expect(() => normalizeHfBucketsConfig({ bucket: 'a/' })).toThrow(/namespace\/name/)
  })
})

describe('normalizeHfRepoConfig', () => {
  it('accepts namespace/name repo ids and keeps revision', () => {
    const config = normalizeHfRepoConfig({
      repo_id: 'ns/model',
      revision: 'v1.0',
    })
    expect(config.repoId).toBe('ns/model')
    expect(config.revision).toBe('v1.0')
  })

  it('accepts a bare repo id, which the Hub resolves against the token', () => {
    // `hf repo create widget` then `hf download widget` is what the real CLI
    // produces, so refusing the bare form rejected an id the Hub had just
    // minted. Probed against the real binary.
    expect(normalizeHfRepoConfig({ repo_id: 'widget' }).repoId).toBe('widget')
  })

  it.each(['a/b/c', 'ns/', '/name', ''])('rejects %s, which the Hub cannot read', (bad) => {
    expect(() => normalizeHfRepoConfig({ repo_id: bad })).toThrow(/namespace\/name/)
  })
})

describe('redaction', () => {
  it('redacts token and fills the default endpoint', () => {
    const redacted = redactHfBucketsConfig({ bucket: 'ns/data', token: 'hf_secret' })
    expect(redacted.token).toBe('<REDACTED>')
    expect(redacted.endpoint).toBe(HF_ENDPOINT)
    expect(redacted.bucket).toBe('ns/data')
  })

  it('redacts repo config token and preserves revision', () => {
    const redacted = redactHfRepoConfig({ repoId: 'ns/model', token: 't', revision: 'main' })
    expect(redacted.token).toBe('<REDACTED>')
    expect(redacted.revision).toBe('main')
    expect(redacted.endpoint).toBe(HF_ENDPOINT)
  })
})
