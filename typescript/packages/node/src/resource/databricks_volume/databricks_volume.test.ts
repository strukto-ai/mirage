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
import { ResourceName } from '@struktoai/mirage-core/types'
import {
  StaticTokenProvider,
  type TokenProvider,
} from '@struktoai/mirage-core/resource/databricks_volume/token_provider'
import { normalizeDatabricksVolumeConfig, redactDatabricksVolumeConfig } from './config.ts'
import { DatabricksVolumeResource } from './databricks_volume.ts'
import { buildResource } from '../registry.ts'

const BASE_CONFIG = {
  catalog: 'main',
  schema: 'default',
  volume: 'agent_files',
  host: 'https://dbc.example.com',
}

describe('config normalization', () => {
  it('accepts snake_case YAML keys and applies defaults', () => {
    const config = normalizeDatabricksVolumeConfig({ ...BASE_CONFIG, root_path: '/root/' })
    expect(config.rootPath).toBe('/root')
    expect(config.timeout).toBe(30)
  })

  it('rejects invalid volume parts', () => {
    expect(() => normalizeDatabricksVolumeConfig({ ...BASE_CONFIG, catalog: 'a/b' })).toThrow()
  })

  it('requires a host and strips its trailing slashes', () => {
    expect(() =>
      normalizeDatabricksVolumeConfig({
        catalog: 'main',
        schema: 'default',
        volume: 'agent_files',
      }),
    ).toThrow()
    expect(() => normalizeDatabricksVolumeConfig({ ...BASE_CONFIG, host: '/' })).toThrow()
    const config = normalizeDatabricksVolumeConfig({ ...BASE_CONFIG, host: 'https://dbc.io//' })
    expect(config.host).toBe('https://dbc.io')
  })

  it('carries no credential to redact', () => {
    const config = normalizeDatabricksVolumeConfig(BASE_CONFIG)
    const redacted = redactDatabricksVolumeConfig(config)
    expect(redacted).toEqual(config)
    expect(JSON.stringify(redacted)).not.toContain('REDACTED')
  })
})

describe('DatabricksVolumeResource', () => {
  it('creates with a token provider and exposes commands/ops', async () => {
    const resource = await DatabricksVolumeResource.create(
      normalizeDatabricksVolumeConfig(BASE_CONFIG),
      new StaticTokenProvider('tok-123'),
    )
    expect(resource.kind).toBe(ResourceName.DATABRICKS_VOLUME)
    expect(resource.cachesReads).toBe(true)
    expect(resource.commands().length).toBeGreaterThan(20)
    expect(resource.ops().map((op) => op.name)).toContain('write')
  })

  it('holds the provider on the accessor and no token of its own', () => {
    const provider: TokenProvider = new StaticTokenProvider('tok-123')
    const resource = new DatabricksVolumeResource(
      normalizeDatabricksVolumeConfig(BASE_CONFIG),
      provider,
    )
    expect(resource.accessor.tokenProvider).toBe(provider)
    expect(resource.accessor.host).toBe('https://dbc.example.com')
    expect((resource.accessor as unknown as { token?: string }).token).toBeUndefined()
  })

  it('state carries no secret and demands an override at load', async () => {
    const resource = new DatabricksVolumeResource(
      normalizeDatabricksVolumeConfig(BASE_CONFIG),
      new StaticTokenProvider('tok-123'),
    )
    const state = await resource.getState()
    expect(state.needs_override).toBe(true)
    expect(state.config.host).toBe('https://dbc.example.com')
    expect(state.config).not.toHaveProperty('token')
    expect(state.config).not.toHaveProperty('profile')
  })

  it('refuses to build from the registry, which has no provider to offer', async () => {
    await expect(
      buildResource('databricks_volume', { ...BASE_CONFIG, root_path: '/r' }),
    ).rejects.toThrow('token provider is required')
  })
})
