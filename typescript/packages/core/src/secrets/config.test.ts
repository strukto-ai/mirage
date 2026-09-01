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

import { EnvVarSchema, SourceBlockSchema } from './config.ts'

describe('EnvVarSchema', () => {
  it('parses a literal entry with defaults', () => {
    const entry = EnvVarSchema.parse({ value: 'vi' })
    expect(entry.value).toBe('vi')
    expect(entry.readonly).toBe(false)
    expect(entry.export).toBe(true)
    expect(entry.from).toBeUndefined()
  })

  it('parses a managed entry with defaults', () => {
    const entry = EnvVarSchema.parse({ from: 'aws-sm', ref: 'prod/tokens' })
    expect(entry.from).toBe('aws-sm')
    expect(entry.ref).toBe('prod/tokens')
    expect(entry.key).toBeUndefined()
    expect(entry.fetch).toBe('lazy')
  })

  it("refuses 'value' and 'from' together", () => {
    expect(() => EnvVarSchema.parse({ value: 'v', from: 'env' })).toThrowError(/not both/)
  })

  it("needs 'value' or 'from'", () => {
    expect(() => EnvVarSchema.parse({})).toThrowError(/needs 'value' or 'from'/)
  })

  it('refuses readonly on a managed entry', () => {
    expect(() => EnvVarSchema.parse({ from: 'env', readonly: true })).toThrowError(/readonly/)
  })

  it('refuses export:false on a managed entry', () => {
    expect(() => EnvVarSchema.parse({ from: 'env', export: false })).toThrowError(/always exported/)
  })

  it('refuses managed knobs on a literal entry', () => {
    expect(() => EnvVarSchema.parse({ value: 'v', key: 'k' })).toThrowError(/managed entries/)
    expect(() => EnvVarSchema.parse({ value: 'v', fetch: 'eager' })).toThrowError(/managed entries/)
  })

  it('rejects an unknown key', () => {
    expect(() => EnvVarSchema.parse({ value: 'v', bogus: 1 })).toThrowError()
  })
})

describe('SourceBlockSchema', () => {
  it('keeps a __proto__ config key as an own property', () => {
    // Keyed assignment would run the prototype setter and the key
    // would never reach the source's own model; python's dict passes
    // it through like any other.
    const block = SourceBlockSchema.parse({
      source: 'demo',
      config: Object.fromEntries([['__proto__', 'kept']]),
    })
    expect(Object.hasOwn(block.config, '__proto__')).toBe(true)
    expect(block.config.__proto__).toBe('kept')
  })

  it('takes a type and a config', () => {
    const block = SourceBlockSchema.parse({
      source: 'aws-sm',
      config: { region: 'us-east-2' },
    })
    expect(block.source).toBe('aws-sm')
    expect(block.config).toEqual({ region: 'us-east-2' })
  })

  it('reads a config value carrying from as a pointer', () => {
    const block = SourceBlockSchema.parse({
      source: 'aws-sm',
      config: { aws_access_key_id: { from: 'env', key: 'KEY_ID' } },
    })
    expect(block.config.aws_access_key_id).toEqual({ from: 'env', ref: '', key: 'KEY_ID' })
  })

  it('leaves a config value without from a literal', () => {
    const block = SourceBlockSchema.parse({
      source: 'aws-sm',
      config: { tags: { team: 'infra' } },
    })
    expect(block.config.tags).toEqual({ team: 'infra' })
  })

  it('defaults the config to empty', () => {
    expect(SourceBlockSchema.parse({ source: 'env' }).config).toEqual({})
  })

  it.each(['1password', 'aws-sm', 'auth0'])('refuses %s as a config source', (source) => {
    expect(() =>
      SourceBlockSchema.parse({ source: 'aws-sm', config: { region: { from: source, key: 'r' } } }),
    ).toThrowError(/needs no config of its own/)
  })

  it.each(['env', 'dotenv'])('accepts %s as a config source', (source) => {
    const block = SourceBlockSchema.parse({
      source: 'aws-sm',
      config: { region: { from: source, key: 'r' } },
    })
    expect((block.config.region as { from: string }).from).toBe(source)
  })

  it('refuses an unknown key on a pointer', () => {
    expect(() =>
      SourceBlockSchema.parse({
        source: 'aws-sm',
        config: { region: { from: 'env', key: 'r', sticky: true } },
      }),
    ).toThrowError()
  })

  it('refuses an unknown key on the block', () => {
    expect(() => SourceBlockSchema.parse({ source: 'env', account: 'x' })).toThrowError()
  })
})
