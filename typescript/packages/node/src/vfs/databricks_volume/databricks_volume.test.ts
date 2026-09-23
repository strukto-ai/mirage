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
import { VFSName } from '@struktoai/mirage-core/types'
import { normalizeDatabricksVolumeConfig, redactDatabricksVolumeConfig } from './config.ts'
import { DatabricksVolumeVFS } from './databricks_volume.ts'
import { parseDatabricksCfg } from './profile.ts'
import { buildVfs } from '../registry.ts'

const BASE_CONFIG = {
  catalog: 'main',
  schema: 'default',
  volume: 'agent_files',
  host: 'https://dbc.example.com',
  token: 'tok-123',
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

  it('redacts the token', () => {
    const config = normalizeDatabricksVolumeConfig(BASE_CONFIG)
    const redacted = redactDatabricksVolumeConfig(config)
    expect(redacted.token).toBe('<REDACTED>')
    expect(redacted.catalog).toBe('main')
  })
})

describe('parseDatabricksCfg', () => {
  it('extracts host and token from the named section', () => {
    const content = [
      '[DEFAULT]',
      'host = https://default.example.com',
      'token = tok-default',
      '',
      '[work]',
      'host = https://work.example.com',
      'token = tok-work',
    ].join('\n')
    expect(parseDatabricksCfg(content, 'work')).toEqual({
      host: 'https://work.example.com',
      token: 'tok-work',
    })
    expect(parseDatabricksCfg(content, 'DEFAULT')).toEqual({
      host: 'https://default.example.com',
      token: 'tok-default',
    })
    expect(parseDatabricksCfg(content, 'missing')).toEqual({})
  })
})

describe('DatabricksVolumeVFS', () => {
  it('creates with explicit credentials and exposes commands/ops', async () => {
    const vfs = await DatabricksVolumeVFS.create(normalizeDatabricksVolumeConfig(BASE_CONFIG))
    expect(vfs.kind).toBe(VFSName.DATABRICKS_VOLUME)
    expect(vfs.cachesReads).toBe(true)
    expect(vfs.commands().length).toBeGreaterThan(20)
    expect(vfs.ops().map((op) => op.name)).toContain('write')
    const state = await vfs.getState()
    expect(state.config.token).toBe('<REDACTED>')
  })

  it('builds via the registry under the python name', async () => {
    const vfs = await buildVfs('databricks_volume', { ...BASE_CONFIG, root_path: '/r' })
    expect(vfs.kind).toBe(VFSName.DATABRICKS_VOLUME)
  })
})
