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
import { buildResource, knownResources, register } from './registry.ts'

describe('browser resource registry', () => {
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
    expect(names).toContain('nowledge_mem')
    expect(names).toEqual([...names].sort())
  })

  it('builds RAM with no config', async () => {
    const r = await buildResource('ram', {})
    expect(r.kind).toBe('ram')
  })

  it('builds Nowledge Mem with API config', async () => {
    const r = (await buildResource('nowledge_mem', {
      api_url: 'https://mem.example',
    })) as unknown as { kind: string; config: Record<string, unknown> }
    expect(r.kind).toBe('nowledge_mem')
    expect(r.config).toMatchObject({ apiUrl: 'https://mem.example' })
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
    const { MemoryOAuthClientProvider } = await import('@struktoai/mirage-core')
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
      const { RAMResource } = await import('@struktoai/mirage-core')
      return new RAMResource()
    })
    expect(knownResources()).toContain('mock-fs')
    const r = await buildResource('mock-fs', {})
    expect(r.kind).toBe('ram')
  })
})
