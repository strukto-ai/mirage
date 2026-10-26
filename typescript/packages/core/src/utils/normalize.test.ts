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
import { normalizeFields, snakeToCamel } from './normalize.ts'

describe('snakeToCamel', () => {
  it('handles single underscores', () => {
    expect(snakeToCamel('key_prefix')).toBe('keyPrefix')
    expect(snakeToCamel('aws_access_key_id')).toBe('awsAccessKeyId')
  })

  it('passes single words unchanged', () => {
    expect(snakeToCamel('bucket')).toBe('bucket')
    expect(snakeToCamel('region')).toBe('region')
  })

  it('passes already-camelCase unchanged', () => {
    expect(snakeToCamel('keyPrefix')).toBe('keyPrefix')
    expect(snakeToCamel('accessKeyId')).toBe('accessKeyId')
  })

  it('handles trailing digits', () => {
    expect(snakeToCamel('utf_8')).toBe('utf8')
  })
})

describe('normalizeFields', () => {
  it('default: snake_case → camelCase', () => {
    const out = normalizeFields({ key_prefix: 'mirage:', url: 'redis://x' })
    expect(out).toEqual({ keyPrefix: 'mirage:', url: 'redis://x' })
  })

  it('passes camelCase through unchanged', () => {
    const out = normalizeFields({ keyPrefix: 'mirage:', url: 'redis://x' })
    expect(out).toEqual({ keyPrefix: 'mirage:', url: 'redis://x' })
  })

  it('explicit rename overrides default snake→camel', () => {
    const out = normalizeFields(
      { aws_access_key_id: 'AKIA', endpoint_url: 'https://x' },
      {
        rename: {
          aws_access_key_id: 'accessKeyId',
          endpoint_url: 'endpoint',
        },
      },
    )
    expect(out).toEqual({ accessKeyId: 'AKIA', endpoint: 'https://x' })
  })

  it('drops listed keys', () => {
    const out = normalizeFields({ bucket: 'b', proxy: 'http://p' }, { drop: ['proxy'] })
    expect(out).toEqual({ bucket: 'b' })
  })
})
