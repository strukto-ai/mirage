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
import { normalizeS3Config } from './s3/config.ts'
import { buildResource, knownResources, register } from './registry.ts'

describe('node resource registry', () => {
  it('lists known resources sorted', () => {
    const names = knownResources()
    expect(names).toContain('ram')
    expect(names).toContain('disk')
    expect(names).toContain('redis')
    expect(names).toContain('s3')
    expect(names).toContain('postgres')
    expect(names).toContain('mongodb')
    expect(names).toEqual([...names].sort())
  })

  it('builds MongoDB with uri', async () => {
    const r = await buildResource('mongodb', { uri: 'mongodb://localhost' })
    expect(r.kind).toBe('mongodb')
  })

  it('builds Postgres with dsn', async () => {
    const r = await buildResource('postgres', {
      dsn: 'postgres://localhost/db',
    })
    expect(r.kind).toBe('postgres')
  })

  it('Postgres: accepts snake_case max_read_rows → maxReadRows', async () => {
    const r = (await buildResource('postgres', {
      dsn: 'postgres://localhost/db',
      max_read_rows: 50,
    })) as unknown as { config: { maxReadRows: number } }
    expect(r.config.maxReadRows).toBe(50)
  })

  it('builds Notion with api key', async () => {
    const r = await buildResource('notion', { api_key: 'secret' })
    expect(r.kind).toBe('notion')
  })

  it('builds RAM with no config', async () => {
    const r = await buildResource('ram', {})
    expect(r.kind).toBe('ram')
  })

  it('builds Disk with root', async () => {
    const r = await buildResource('disk', { root: '/tmp' })
    expect(r.kind).toBe('disk')
  })

  it('builds S3 with bucket', async () => {
    const r = await buildResource('s3', {
      bucket: 'test-bucket',
      region: 'us-east-1',
    })
    expect(r.kind).toBe('s3')
  })

  it('throws on unknown name with helpful message', async () => {
    await expect(buildResource('nope', {})).rejects.toThrow(/unknown resource/)
    await expect(buildResource('nope', {})).rejects.toThrow(/known: /)
  })

  it('supports registering a custom factory', async () => {
    register('mock-fs', async () => {
      const { RAMResource } = await import('@struktoai/mirage-core')
      return new RAMResource()
    })
    expect(knownResources()).toContain('mock-fs')
    const r = await buildResource('mock-fs', {})
    expect(r.kind).toBe('ram')
  })

  it('S3: accepts Python YAML snake_case keys', async () => {
    const { config } = (await buildResource('s3', {
      bucket: 'b',
      region: 'us-east-1',
      aws_access_key_id: 'AKIA',
      aws_secret_access_key: 'SECRET',
      aws_session_token: 'SESS',
      aws_profile: 'prod',
      endpoint_url: 'https://example.com',
      path_style: true,
      timeout: 30,
      proxy: 'http://discarded',
    })) as unknown as { config: Record<string, unknown> }
    expect(config).toMatchObject({
      bucket: 'b',
      region: 'us-east-1',
      accessKeyId: 'AKIA',
      secretAccessKey: 'SECRET',
      sessionToken: 'SESS',
      profile: 'prod',
      endpoint: 'https://example.com',
      forcePathStyle: true,
      timeoutMs: 30_000,
    })
    expect(config).not.toHaveProperty('proxy')
  })

  it('S3: accepts already-camelCase keys (TS-idiomatic)', async () => {
    const { config } = (await buildResource('s3', {
      bucket: 'b',
      accessKeyId: 'AKIA',
      secretAccessKey: 'SECRET',
      forcePathStyle: false,
    })) as unknown as { config: Record<string, unknown> }
    expect(config).toMatchObject({
      bucket: 'b',
      accessKeyId: 'AKIA',
      secretAccessKey: 'SECRET',
      forcePathStyle: false,
    })
  })

  it('Redis: snake_case key_prefix → keyPrefix', async () => {
    const r = (await buildResource('redis', {
      url: 'redis://localhost:6379/0',
      key_prefix: 'mirage:test:',
    })) as { kind: string }
    expect(r.kind).toBe('redis')
  })

  it('Nextcloud: accepts Python YAML snake_case keys', async () => {
    const resource = await buildResource('nextcloud', {
      url: 'https://cloud.example/remote.php/dav/files/alice/',
      username: 'alice',
      password: 'secret',
      verify_ssl: false,
    })
    expect(resource.kind).toBe('nextcloud')
    const { config } = resource as unknown as {
      config: { username?: string; verifySsl?: boolean }
    }
    expect(config).toMatchObject({ username: 'alice', verifySsl: false })
  })

  it('normalizeS3Config standalone', () => {
    expect(
      normalizeS3Config({
        bucket: 'b',
        aws_access_key_id: 'A',
        endpoint_url: 'https://x',
        timeout: 5,
        proxy: 'p',
      }),
    ).toEqual({
      bucket: 'b',
      accessKeyId: 'A',
      endpoint: 'https://x',
      timeoutMs: 5_000,
    })
  })
})

describe('hf resources in registry', () => {
  it('lists all four hf resources', () => {
    const names = knownResources()
    for (const n of ['hf_buckets', 'hf_datasets', 'hf_models', 'hf_spaces']) {
      expect(names).toContain(n)
    }
  })

  it('builds hf_models from Python YAML snake_case keys', async () => {
    const r = await buildResource('hf_models', {
      repo_id: 'ns/model',
      token: 't',
      key_prefix: 'sub',
      timeout: 30,
      revision: 'main',
    })
    expect(r.kind).toBe('hf_models')
    const { config } = r as unknown as {
      config: { repoId: string; keyPrefix?: string; timeoutMs?: number; revision?: string }
    }
    expect(config.repoId).toBe('ns/model')
    expect(config.keyPrefix).toBe('sub/')
    expect(config.timeoutMs).toBe(30000)
    expect(config.revision).toBe('main')
  })

  it('builds hf_buckets, hf_datasets, and hf_spaces', async () => {
    expect((await buildResource('hf_buckets', { bucket: 'ns/b' })).kind).toBe('hf_buckets')
    expect((await buildResource('hf_datasets', { repo_id: 'ns/d' })).kind).toBe('hf_datasets')
    expect((await buildResource('hf_spaces', { repo_id: 'ns/s' })).kind).toBe('hf_spaces')
  })

  it('rejects malformed hf repo ids', async () => {
    await expect(buildResource('hf_models', { repo_id: 'plain' })).rejects.toThrow(
      /namespace\/name/,
    )
  })
})
