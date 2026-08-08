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

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  Mem0Resource,
  normalizeMem0Config,
  normalizeOneDriveConfig,
  OneDriveResource,
  ResourceName,
  resourceStateRequiresOverride,
  tokenUrl,
  type TokenManager,
} from '@struktoai/mirage-core'
import { normalizeS3Config } from './s3/config.ts'
import { buildResource, knownResources, register } from './registry.ts'

// Captured before any test calls register(), which is the public hook for
// custom resources and legitimately adds names with no ResourceName.
const BUILTIN_RESOURCES = knownResources()

// The committed dump scripts/check_spec_parity.py diffs against Python. This
// used to be nine hand-written `toContain` spot-checks, which could not
// notice that chroma/dify/lancedb/qdrant had no factory at all.
const SPEC_RESOURCES = resolve(
  fileURLToPath(import.meta.url),
  '../../../../../../spec/typescript/node/resources.json',
)

describe('node resource registry', () => {
  it('matches the committed spec manifest, sorted', () => {
    const manifest = JSON.parse(readFileSync(SPEC_RESOURCES, 'utf8')) as { registry: string[] }
    expect(BUILTIN_RESOURCES).toEqual([...manifest.registry].sort())
    expect(BUILTIN_RESOURCES).toEqual([...BUILTIN_RESOURCES].sort())
  })

  // The four Drive-family resources used to redeclare core's GoogleConfig
  // without apiBase and hand-pick TokenManager fields, so a mount pointed
  // at a fake server still refreshed its token at Google's real endpoint.
  it('threads api_base into every google resource token manager', async () => {
    const base = 'http://127.0.0.1:9999'
    for (const name of ['gdrive', 'gdocs', 'gsheets', 'gslides', 'gmail']) {
      const resource = await buildResource(name, {
        client_id: 'id',
        client_secret: 'secret',
        refresh_token: 'refresh',
        api_base: base,
      })
      const { accessor } = resource as unknown as { accessor: { tokenManager: TokenManager } }
      expect(tokenUrl(accessor.tokenManager.config), name).toBe(`${base}/token`)
    }
  })

  it('builds Microsoft Graph and Mem0 resources from snake_case config', async () => {
    const oneDrive = await buildResource('onedrive', {
      access_token: 'token',
      drive_id: 'drive',
    })
    const sharePoint = await buildResource('sharepoint', { access_token: 'token' })
    const mem0 = await buildResource('mem0', { api_key: 'key', user_id: 'user' })

    expect(oneDrive.kind).toBe('onedrive')
    expect(sharePoint.kind).toBe('sharepoint')
    expect(mem0.kind).toBe('mem0')
  })

  // The factories used to double-cast an unvalidated blob, so a bad config
  // only failed later at the first API call.
  it('validates Microsoft Graph and Mem0 config instead of casting it through', async () => {
    await expect(buildResource('onedrive', { drive_id: 'drive' })).rejects.toThrow()
    await expect(buildResource('sharepoint', { access_token: 7 })).rejects.toThrow()
    await expect(buildResource('mem0', { api_key: 'key', user_id: 3 })).rejects.toThrow()
  })

  // getState() used to hand-write the redacted literal, so a field added to
  // the config later would silently leak or vanish from snapshot state. It is
  // schema-driven now, so the config shape is the single source of truth.
  it('redacts Graph and Mem0 secrets in state and keeps every other field', () => {
    const oneDrive = new OneDriveResource(
      normalizeOneDriveConfig({ access_token: 'token', drive_id: 'drive', key_prefix: 'sub' }),
    )
    const mem0 = new Mem0Resource(
      normalizeMem0Config({ api_key: 'key', user_id: 'user', default_page_size: 5 }),
    )

    expect(oneDrive.getState()).toEqual({
      type: 'onedrive',
      config: { accessToken: '<REDACTED>', driveId: 'drive', keyPrefix: 'sub' },
    })
    expect(mem0.getState()).toEqual({
      type: 'mem0',
      config: { apiKey: '<REDACTED>', userId: 'user', defaultPageSize: 5 },
    })
    expect(resourceStateRequiresOverride(oneDrive.getState())).toBe(true)
    expect(resourceStateRequiresOverride(mem0.getState())).toBe(true)
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
      proxy: 'http://proxy.example',
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
      proxy: 'http://proxy.example',
    })
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
      proxy: 'p',
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

describe('ResourceName coverage', () => {
  // Names that are deliberately not buildable from the node registry.
  const BROWSER_ONLY = new Set(['opfs'])
  // `history` is an internal view mount, never named in user config.
  const INTERNAL = new Set(['history'])
  // Config-mountable in python but not yet wired into a TypeScript registry.
  // Listing them keeps the gap visible instead of hiding it behind a count.
  const PYTHON_ONLY = new Set(['chroma', 'dify', 'lancedb', 'qdrant'])

  it('every resource name is buildable or explicitly exempt', () => {
    // This is the guard a hardcoded entry count cannot give: adding a backend
    // to ResourceName without a registry factory fails here, naming it.
    const known = new Set(BUILTIN_RESOURCES)
    const unreachable = Object.values(ResourceName).filter(
      (name) =>
        !known.has(name) &&
        !BROWSER_ONLY.has(name) &&
        !INTERNAL.has(name) &&
        !PYTHON_ONLY.has(name),
    )
    expect(unreachable).toEqual([])
  })

  it('every built-in registry factory has a ResourceName', () => {
    const names = new Set<string>(Object.values(ResourceName))
    expect(BUILTIN_RESOURCES.filter((n) => !names.has(n))).toEqual([])
  })
})
