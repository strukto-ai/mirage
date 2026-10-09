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

import type { OAuthClientMetadata } from '@modelcontextprotocol/client'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tokenUrl } from '@struktoai/mirage-core/core/google/client'
import type { TokenManager } from '@struktoai/mirage-core/core/google/client'
import { VFSName } from '@struktoai/mirage-core/types'
import { TrelloVFS } from '@struktoai/mirage-core/vfs/trello/trello'
import { buildVfs, knownVfsNames, register } from './registry.ts'

describe('browser VFS registry', () => {
  // The four Drive-family VFS used to redeclare core's GoogleConfig
  // without apiBase and hand-pick TokenManager fields, so a mount pointed
  // at a fake server still refreshed its token at Google's real endpoint.
  it('threads api_base into every google VFS token manager', async () => {
    const base = 'http://127.0.0.1:9999'
    for (const name of ['gdrive', 'gdocs', 'gsheets', 'gslides', 'gmail']) {
      const vfs = await buildVfs(name, {
        client_id: 'id',
        client_secret: 'secret',
        refresh_token: 'refresh',
        api_base: base,
      })
      const { accessor } = vfs as unknown as { accessor: { tokenManager: TokenManager } }
      expect(tokenUrl(accessor.tokenManager.config), name).toBe(`${base}/token`)
    }
  })

  // The browser kept its own copy of the Box config after node grew the
  // client-credentials grant, and zod strips a key its schema does not
  // declare: `enterprise_id` vanished before the token manager ran, which
  // then refused the mount for lacking the very credentials it was given.
  it('keeps the box client-credentials grant', async () => {
    const vfs = await buildVfs('box', {
      client_id: 'id',
      client_secret: 'secret',
      enterprise_id: 'ent',
    })
    expect(vfs.name).toBe('box')
    expect((vfs as unknown as { config: { enterpriseId?: string } }).config.enterpriseId).toBe(
      'ent',
    )
  })

  // Every entry used to hand-roll `normalizeFields` with a rename map that
  // mostly restated what `snakeToCamel` already does, then cast the result
  // through a config interface written a second time in the registry. The
  // casts hid a mismatch: nothing checked that the shape the VFS wants
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
      const state = (await (await buildVfs(name, input)).getState()) as {
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

  it('lists known VFS names sorted', () => {
    const names = knownVfsNames()
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

  it('builds Microsoft Graph and Mem0 mounts from snake_case config', async () => {
    const oneDrive = await buildVfs('onedrive', {
      access_token: 'token',
      drive_id: 'drive',
    })
    const sharePoint = await buildVfs('sharepoint', { access_token: 'token' })
    const mem0 = await buildVfs('mem0', { api_key: 'key', agent_id: 'agent' })

    expect(oneDrive.name).toBe('onedrive')
    expect(sharePoint.name).toBe('sharepoint')
    expect(mem0.name).toBe('mem0')
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
      const r = await buildVfs(name, {
        bucket: 'test-bucket',
        presignedUrlProvider: provider,
      })
      expect(r.name).toBe(name)
    }
  })

  // The browser entry point validates too: a wrong-typed field is refused with the
  // field and the code, the same line the node registry and python's
  // `build_vfs` produce.
  it('refuses a wrong-typed config, naming field and code', async () => {
    const provider = (): Promise<string> => Promise.resolve('https://example.com/signed')
    await expect(buildVfs('s3', { bucket: 123, presignedUrlProvider: provider })).rejects.toThrow(
      /^s3: bucket: invalid_type$/,
    )
    await expect(buildVfs('gcs', { bucket: 'b', presignedUrlProvider: 'x' })).rejects.toThrow(
      /^gcs: presignedUrlProvider: /,
    )
  })

  // A key no field takes used to be stripped here too; it is refused under
  // the spelling the block wrote, the way the node registry and python's
  // `build_vfs` refuse it.
  it('refuses an unknown config key, schema or none', async () => {
    await expect(buildVfs('linear', { api_key: 'k', team_idz: ['x'] })).rejects.toThrow(
      /^linear: team_idz: unrecognized_keys$/,
    )
    await expect(buildVfs('ram', { root: '/' })).rejects.toThrow(/^ram: root: unrecognized_keys$/)
    await expect(buildVfs('opfs', { root: 'r', roots: 'x' })).rejects.toThrow(
      /^opfs: roots: unrecognized_keys$/,
    )
    await expect(buildVfs('redis', { url: 'https://r', keyprefix: 'a' })).rejects.toThrow(
      /^redis: keyprefix: unrecognized_keys$/,
    )
  })

  it('builds RAM with no config', async () => {
    const r = await buildVfs('ram', {})
    expect(r.name).toBe('ram')
  })

  it('builds S3 with bucket and presignedUrlProvider', async () => {
    const provider = (): Promise<string> => Promise.resolve('https://example.com/signed')
    const r = await buildVfs('s3', {
      bucket: 'test-bucket',
      presignedUrlProvider: provider,
    })
    expect(r.name).toBe('s3')
  })

  it('builds GCS with bucket and presignedUrlProvider', async () => {
    const provider = (): Promise<string> => Promise.resolve('https://example.com/signed')
    const r = await buildVfs('gcs', {
      bucket: 'test-bucket',
      presignedUrlProvider: provider,
    })
    expect(r.name).toBe('gcs')
  })

  it('builds R2 with bucket, accountId, and presignedUrlProvider', async () => {
    const provider = (): Promise<string> => Promise.resolve('https://example.com/signed')
    const r = await buildVfs('r2', {
      bucket: 'test-bucket',
      account_id: 'abc123',
      presignedUrlProvider: provider,
    })
    expect(r.name).toBe('r2')
  })

  it('builds OCI with bucket and presignedUrlProvider', async () => {
    const provider = (): Promise<string> => Promise.resolve('https://example.com/signed')
    const r = await buildVfs('oci', {
      bucket: 'test-bucket',
      namespace: 'mytenant',
      region: 'us-ashburn-1',
      presignedUrlProvider: provider,
    })
    expect(r.name).toBe('oci')
  })

  it('builds Supabase with bucket, projectRef, and presignedUrlProvider', async () => {
    const provider = (): Promise<string> => Promise.resolve('https://example.com/signed')
    const r = await buildVfs('supabase', {
      bucket: 'test-bucket',
      project_ref: 'abcdefgh',
      presignedUrlProvider: provider,
    })
    expect(r.name).toBe('supabase')
  })

  it('builds a NotionVFS via buildVfs', async () => {
    const { MemoryOAuthClientProvider } = await import('@struktoai/mirage-core/core/notion/client')
    const clientMetadata: OAuthClientMetadata = {
      redirect_uris: ['http://example.com/cb'],
    } as OAuthClientMetadata
    const provider = new MemoryOAuthClientProvider({
      clientMetadata,
      redirect: (_url: URL): void => undefined,
    })
    const r = await buildVfs('notion', { authProvider: provider })
    expect(r.name).toBe('notion')
  })

  it('throws on unknown name with helpful message', async () => {
    await expect(buildVfs('nope', {})).rejects.toThrow(/unknown VFS/)
    await expect(buildVfs('nope', {})).rejects.toThrow(/known: /)
  })

  it('supports registering a custom factory', async () => {
    register('mock-fs', async () => {
      const { RAMVFS } = await import('@struktoai/mirage-core/vfs/ram/ram')
      return new RAMVFS()
    })
    expect(knownVfsNames()).toContain('mock-fs')
    const r = await buildVfs('mock-fs', {})
    expect(r.name).toBe('ram')
  })
})

describe('browser registry: trello', () => {
  it('builds trello VFS with apiKey/apiToken', async () => {
    const r = await buildVfs('trello', { apiKey: 'k', apiToken: 't' })
    expect(r.name).toBe(VFSName.TRELLO)
    expect(r).toBeInstanceOf(TrelloVFS)
  })

  it('accepts snake_case config (api_key, api_token, workspace_id, board_ids)', async () => {
    const r = (await buildVfs('trello', {
      api_key: 'k',
      api_token: 't',
      workspace_id: 'w1',
      board_ids: ['b1', 'b2'],
    })) as TrelloVFS
    expect(r.config.apiKey).toBe('k')
    expect(r.config.apiToken).toBe('t')
    expect(r.config.workspaceId).toBe('w1')
    expect(r.config.boardIds).toEqual(['b1', 'b2'])
  })
})

describe('the write-condition table covers the browser registry', () => {
  // Each browser backend needs its row in integ/fixtures/write/conditions.json.
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('../../../../../integ/fixtures/write/conditions.json', import.meta.url),
      ),
      'utf8',
    ),
  ) as { vfs: Record<string, string[]> }

  // Captured before any test registers a backend of its own.
  const names = knownVfsNames()

  it('has a row for every registered VFS', () => {
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((n) => !(n in fixture.vfs))).toEqual([])
  })
})
