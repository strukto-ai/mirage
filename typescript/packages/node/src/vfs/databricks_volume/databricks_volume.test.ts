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

import { describe, expect, it, vi } from 'vitest'
import { toStateDict } from '@struktoai/mirage-core/workspace/snapshot/state'
import { Workspace } from '../../workspace.ts'
import { commandsFor } from '@struktoai/mirage-core/workspace/mount/backends'
import { VFSName } from '@struktoai/mirage-core/types'
import { normalizeDatabricksVolumeConfig, redactDatabricksVolumeConfig } from './config.ts'
import { DatabricksVolumeVFS } from './databricks_volume.ts'
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
  })

  it.each([
    'https://example.com?',
    'https://example.com#',
    'https://example.com\\extra',
    'https://example.com\n',
  ])('rejects malformed origin %j', (host) => {
    expect(() => normalizeDatabricksVolumeConfig({ ...BASE_CONFIG, host })).toThrow()
  })

  it('normalizes the workspace origin', () => {
    expect(
      normalizeDatabricksVolumeConfig({ ...BASE_CONFIG, host: 'HTTPS://EXAMPLE.COM:443/' }).host,
    ).toBe('https://example.com')
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

describe('DatabricksVolumeVFS', () => {
  it('creates with explicit credentials and exposes commands and writes', async () => {
    const vfs = await DatabricksVolumeVFS.create(normalizeDatabricksVolumeConfig(BASE_CONFIG))
    expect(vfs.name).toBe(VFSName.DATABRICKS_VOLUME)
    expect(vfs.cachesReads).toBe(true)
    expect(commandsFor(vfs)).toEqual([])
    expect(vfs.supports('write')).toBe(true)
    const state = await vfs.getState()
    expect(state.config.token).toBe('<REDACTED>')
  })

  it('builds via the registry under the python name', async () => {
    const vfs = await buildVfs('databricks_volume', { ...BASE_CONFIG, root_path: '/r' })
    expect(vfs.name).toBe(VFSName.DATABRICKS_VOLUME)
  })
})

const location = async (root: string, token: string): Promise<string | null> =>
  (
    await DatabricksVolumeVFS.create(
      normalizeDatabricksVolumeConfig({ ...BASE_CONFIG, root_path: root, token }),
    )
  ).storageLocation()

// Twin of test_a_volume_root_is_one_store_whatever_its_token.
describe('DatabricksVolumeVFS storageLocation', () => {
  it('is one store for one volume root whatever its token', async () => {
    expect(await location('/root', 'a')).toBe(await location('/root/', 'b'))
    expect(await location('/root', 'a')).not.toBe(await location('/other', 'a'))
  })
})

describe('DatabricksVolumeVFS rotating credential state', () => {
  it('requires an override after redacting a callback and restores with a fresh provider', async () => {
    const token = vi.fn().mockReturnValue('secret-token')
    const vfs = await DatabricksVolumeVFS.create(
      normalizeDatabricksVolumeConfig({ ...BASE_CONFIG, token }),
    )
    const workspace = new Workspace({ '/volume': vfs })
    try {
      const state = await toStateDict(workspace)
      expect(JSON.stringify(state)).not.toContain('secret-token')
      expect(token).not.toHaveBeenCalled()
      await expect(Workspace.fromState(state)).rejects.toThrow('needs_override')
      const replacement = await DatabricksVolumeVFS.create(
        normalizeDatabricksVolumeConfig({
          ...BASE_CONFIG,
          token: () => Promise.resolve('fresh-token'),
        }),
      )
      const restored = await Workspace.fromState(state, {}, { '/volume': replacement })
      try {
        expect(await restored.shell('pwd')).toMatchObject({ exitCode: 0 })
      } finally {
        await restored.close()
      }
    } finally {
      await workspace.close()
    }
  })
})
