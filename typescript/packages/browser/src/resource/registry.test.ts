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

import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import { describe, expect, it } from 'vitest'
import { tokenUrl } from '@struktoai/mirage-core/core/google/client'
import type { TokenManager } from '@struktoai/mirage-core/core/google/client'
import { buildResource, knownResources, register } from './registry.ts'

describe('browser resource registry', () => {
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

  // Every entry used to hand-roll `normalizeFields` with a rename map that
  // mostly restated what `snakeToCamel` already does, then cast the result
  // through a config interface written a second time in the registry. The
  // casts hid a mismatch: nothing checked that the shape the resource wants
  // is the shape the entry produces.
  it('normalizes snake_case config for every hand-wired backend', async () => {
    const provider = (): Promise<string> => Promise.resolve('https://example.com/signed')
    const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
      [
        'trello',
        { api_key: 'k', api_token: 't', workspace_id: 'w', board_ids: ['b'], base_url: 'u' },
        { workspaceId: 'w', boardIds: ['b'], baseUrl: 'u' },
      ],
      [
        'langfuse',
        { public_key: 'p', secret_key: 's', default_trace_limit: 5, default_search_limit: 6 },
        { publicKey: 'p', defaultTraceLimit: 5, defaultSearchLimit: 6 },
      ],
      ['slack', { proxy_url: 'http://x' }, { proxyUrl: 'http://x' }],
      ['discord', { proxy_url: 'http://x' }, { proxyUrl: 'http://x' }],
      [
        's3',
        { bucket: 'b', presignedUrlProvider: provider, endpoint_url: 'http://e', key_prefix: 'p/' },
        { bucket: 'b', endpoint: 'http://e', keyPrefix: 'p/' },
      ],
      [
        'minio',
        { bucket: 'b', presignedUrlProvider: provider, endpoint_url: 'http://e' },
        { bucket: 'b', endpoint: 'http://e' },
      ],
    ]
    for (const [name, input, expected] of cases) {
      const state = (await (await buildResource(name, input)).getState()) as {
        config: Record<string, unknown>
      }
      expect(state.config, name).toMatchObject(expected)
      // `endpoint_url` is the one rename that is not mechanical; a leftover
      // snake_case key means the entry skipped normalization entirely.
      for (const key of Object.keys(state.config)) {
        expect(key, `${name}.${key}`).not.toContain('_')
      }
    }
  })

  it('lists known resources sorted', () => {
    const names = knownResources()
    expect(names).toContain('ram')
    expect(names).toContain('opfs')
    expect(names).toContain('s3')
    expect(names).toContain('gcs')
    expect(names).toContain('r2')
    expect(names).toContain('oci')
    expect(names).toContain('supabase')
    expect(names).toContain('slack')
    expect(names).toContain('minio')
    expect(names).toContain('ceph')
    expect(names).toContain('seaweedfs')
    expect(names).toContain('wasabi')
    expect(names).toContain('backblaze')
    expect(names).toContain('digitalocean')
    expect(names).toContain('tencent')
    expect(names).toContain('aliyun')
    expect(names).toContain('scaleway')
    expect(names).toContain('qingstor')
    expect(names).toContain('onedrive')
    expect(names).toContain('sharepoint')
    expect(names).toContain('mem0')
    expect(names).toContain('redis')
    expect(names).toEqual([...names].sort())
  })

  it('builds Microsoft Graph and Mem0 resources from snake_case config', async () => {
    const oneDrive = await buildResource('onedrive', {
      access_token: 'token',
      drive_id: 'drive',
    })
    const sharePoint = await buildResource('sharepoint', { access_token: 'token' })
    const mem0 = await buildResource('mem0', { api_key: 'key', agent_id: 'agent' })

    expect(oneDrive.kind).toBe('onedrive')
    expect(sharePoint.kind).toBe('sharepoint')
    expect(mem0.kind).toBe('mem0')
  })

  it('builds each S3-compatible alias with bucket and presignedUrlProvider', async () => {
    const provider = (): Promise<string> => Promise.resolve('https://example.com/signed')
    for (const name of [
      'minio',
      'ceph',
      'seaweedfs',
      'wasabi',
      'backblaze',
      'digitalocean',
      'tencent',
      'aliyun',
      'scaleway',
      'qingstor',
    ]) {
      const r = await buildResource(name, {
        bucket: 'test-bucket',
        presignedUrlProvider: provider,
      })
      expect(r.kind).toBe(name)
    }
  })

  // The browser door validates too: a wrong-typed field is refused with the
  // field and the code, the same line the node registry and python's
  // `build_resource` produce.
  it('refuses a wrong-typed config, naming field and code', async () => {
    const provider = (): Promise<string> => Promise.resolve('https://example.com/signed')
    await expect(
      buildResource('s3', { bucket: 123, presignedUrlProvider: provider }),
    ).rejects.toThrow(/^s3: bucket: invalid_type$/)
    await expect(buildResource('gcs', { bucket: 'b', presignedUrlProvider: 'x' })).rejects.toThrow(
      /^gcs: presignedUrlProvider: /,
    )
  })

  it('builds RAM with no config', async () => {
    const r = await buildResource('ram', {})
    expect(r.kind).toBe('ram')
  })

  it('builds S3 with bucket and presignedUrlProvider', async () => {
    const provider = (): Promise<string> => Promise.resolve('https://example.com/signed')
    const r = await buildResource('s3', {
      bucket: 'test-bucket',
      presignedUrlProvider: provider,
    })
    expect(r.kind).toBe('s3')
  })

  it('builds GCS with bucket and presignedUrlProvider', async () => {
    const provider = (): Promise<string> => Promise.resolve('https://example.com/signed')
    const r = await buildResource('gcs', {
      bucket: 'test-bucket',
      presignedUrlProvider: provider,
    })
    expect(r.kind).toBe('gcs')
  })

  it('builds R2 with bucket, accountId, and presignedUrlProvider', async () => {
    const provider = (): Promise<string> => Promise.resolve('https://example.com/signed')
    const r = await buildResource('r2', {
      bucket: 'test-bucket',
      account_id: 'abc123',
      presignedUrlProvider: provider,
    })
    expect(r.kind).toBe('r2')
  })

  it('builds OCI with bucket and presignedUrlProvider', async () => {
    const provider = (): Promise<string> => Promise.resolve('https://example.com/signed')
    const r = await buildResource('oci', {
      bucket: 'test-bucket',
      namespace: 'mytenant',
      region: 'us-ashburn-1',
      presignedUrlProvider: provider,
    })
    expect(r.kind).toBe('oci')
  })

  it('builds Supabase with bucket, projectRef, and presignedUrlProvider', async () => {
    const provider = (): Promise<string> => Promise.resolve('https://example.com/signed')
    const r = await buildResource('supabase', {
      bucket: 'test-bucket',
      project_ref: 'abcdefgh',
      presignedUrlProvider: provider,
    })
    expect(r.kind).toBe('supabase')
  })

  it('builds a NotionResource via buildResource', async () => {
    const { MemoryOAuthClientProvider } = await import('@struktoai/mirage-core/core/notion/_oauth')
    const clientMetadata: OAuthClientMetadata = {
      redirect_uris: ['http://example.com/cb'],
    } as OAuthClientMetadata
    const provider = new MemoryOAuthClientProvider({
      clientMetadata,
      redirect: (_url: URL): void => undefined,
    })
    const r = await buildResource('notion', { authProvider: provider })
    expect(r.kind).toBe('notion')
  })

  it('throws on unknown name with helpful message', async () => {
    await expect(buildResource('nope', {})).rejects.toThrow(/unknown resource/)
    await expect(buildResource('nope', {})).rejects.toThrow(/known: /)
  })

  it('supports registering a custom factory', async () => {
    register('mock-fs', async () => {
      const { RAMResource } = await import('@struktoai/mirage-core/resource/ram/ram')
      return new RAMResource()
    })
    expect(knownResources()).toContain('mock-fs')
    const r = await buildResource('mock-fs', {})
    expect(r.kind).toBe('ram')
  })
})
