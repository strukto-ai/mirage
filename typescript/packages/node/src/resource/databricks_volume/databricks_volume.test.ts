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
import { REDACTED_SECRET } from '@struktoai/mirage-core/resource/secrets'
import { ResourceName } from '@struktoai/mirage-core/types'
import { normalizeDatabricksVolumeConfig, redactDatabricksVolumeConfig } from './config.ts'
import { DatabricksVolumeResource } from './databricks_volume.ts'
import { buildResource } from '../registry.ts'

const BASE_CONFIG = {
  catalog: 'main',
  schema: 'default',
  volume: 'agent_files',
  host: 'https://dbc.example.com',
  token: 'dapi-123',
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
        token: 'dapi-123',
      }),
    ).toThrow()
    expect(() => normalizeDatabricksVolumeConfig({ ...BASE_CONFIG, host: '/' })).toThrow()
    const config = normalizeDatabricksVolumeConfig({ ...BASE_CONFIG, host: 'https://dbc.io//' })
    expect(config.host).toBe('https://dbc.io')
  })

  it('requires a token', () => {
    expect(() =>
      normalizeDatabricksVolumeConfig({
        catalog: 'main',
        schema: 'default',
        volume: 'agent_files',
        host: 'https://dbc.example.com',
      }),
    ).toThrow()
  })

  it('has no profile field', () => {
    const config = normalizeDatabricksVolumeConfig({ ...BASE_CONFIG, profile: 'DEV' })
    expect(config).not.toHaveProperty('profile')
  })

  it('redacts the token', () => {
    const redacted = redactDatabricksVolumeConfig(normalizeDatabricksVolumeConfig(BASE_CONFIG))
    expect(redacted.token).toBe(REDACTED_SECRET)
    expect(JSON.stringify(redacted)).not.toContain('dapi-123')
  })
})

describe('DatabricksVolumeResource', () => {
  it('exposes commands and ops', () => {
    const resource = new DatabricksVolumeResource(normalizeDatabricksVolumeConfig(BASE_CONFIG))
    expect(resource.kind).toBe(ResourceName.DATABRICKS_VOLUME)
    expect(resource.cachesReads).toBe(true)
    expect(resource.commands().length).toBeGreaterThan(20)
    expect(resource.ops().map((op) => op.name)).toContain('write')
  })

  it('reads the token from the config it was handed', () => {
    const resource = new DatabricksVolumeResource(normalizeDatabricksVolumeConfig(BASE_CONFIG))
    expect(resource.accessor.config.token).toBe('dapi-123')
    expect(resource.accessor.host).toBe('https://dbc.example.com')
  })

  it('state redacts the token, which is what demands an override at load', async () => {
    const resource = new DatabricksVolumeResource(normalizeDatabricksVolumeConfig(BASE_CONFIG))
    const state = await resource.getState()
    expect(state.config.token).toBe(REDACTED_SECRET)
    expect(state.config.host).toBe('https://dbc.example.com')
    expect(state).not.toHaveProperty('needs_override')
  })

  it('builds from the registry like any other declared mount', async () => {
    const resource = await buildResource('databricks_volume', { ...BASE_CONFIG, root_path: '/r' })
    expect(resource).toBeInstanceOf(DatabricksVolumeResource)
  })
})
