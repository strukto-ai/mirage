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

import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { PathSpec } from '../../types.ts'
import {
  normalizeDatabricksVolumeConfig,
  type DatabricksVolumeConfig,
} from '../../resource/databricks_volume/config.ts'
import { backendPath, configuredRoot, normalizePosix, virtualPath, volumeRoot } from './path.ts'

const CONFIG: DatabricksVolumeConfig = normalizeDatabricksVolumeConfig({
  catalog: 'main',
  schema: 'default',
  volume: 'agent_files',
  root_path: '/root',
})

describe('normalizePosix', () => {
  it('collapses dot segments and duplicate slashes', () => {
    expect(normalizePosix('/a//b/./c')).toBe('/a/b/c')
    expect(normalizePosix('/a/b/../c')).toBe('/a/c')
    expect(normalizePosix('/')).toBe('/')
  })
})

describe('volumeRoot / configuredRoot', () => {
  it('joins catalog, schema, and volume', () => {
    expect(volumeRoot(CONFIG)).toBe('/Volumes/main/default/agent_files')
  })

  it('appends the normalized root_path', () => {
    expect(configuredRoot(CONFIG)).toBe('/Volumes/main/default/agent_files/root')
  })

  it('defaults to the volume root without root_path', () => {
    const config = normalizeDatabricksVolumeConfig({
      catalog: 'main',
      schema: 'default',
      volume: 'agent_files',
    })
    expect(configuredRoot(config)).toBe('/Volumes/main/default/agent_files')
  })
})

describe('backendPath', () => {
  it('maps a mounted path under the configured root', () => {
    const path = new PathSpec({
      virtual: '/volume/reports/latest.md',
      directory: '/volume/reports',
      resourcePath: mountKey('/volume/reports/latest.md', '/volume'),
    })
    expect(backendPath(CONFIG, path)).toBe(
      '/Volumes/main/default/agent_files/root/reports/latest.md',
    )
  })

  it('allows normalized paths that stay inside the root', () => {
    const path = new PathSpec({
      virtual: '/volume/reports/../latest.md',
      directory: '/volume/reports',
      resourcePath: mountKey('/volume/reports/../latest.md', '/volume'),
    })
    expect(backendPath(CONFIG, path)).toBe('/Volumes/main/default/agent_files/root/latest.md')
  })

  it('rejects escapes above the configured root', () => {
    const path = new PathSpec({
      virtual: '/volume/../../other_schema/other_volume/secret.txt',
      directory: '/volume',
      resourcePath: mountKey('/volume/../../other_schema/other_volume/secret.txt', '/volume'),
    })
    expect(() => backendPath(CONFIG, path)).toThrow('escapes Databricks volume root')
  })

  it('accepts raw string paths', () => {
    expect(backendPath(CONFIG, '/reports/a.txt')).toBe(
      '/Volumes/main/default/agent_files/root/reports/a.txt',
    )
    expect(backendPath(CONFIG, '/')).toBe('/Volumes/main/default/agent_files/root')
  })
})

describe('config root_path validation', () => {
  it('rejects parent segments in root_path', () => {
    expect(() =>
      normalizeDatabricksVolumeConfig({
        catalog: 'main',
        schema: 'default',
        volume: 'agent_files',
        root_path: '/root/../other',
      }),
    ).toThrow()
  })
})

describe('virtualPath', () => {
  it('maps backend paths back under the mount prefix', () => {
    expect(
      virtualPath(CONFIG, '/Volumes/main/default/agent_files/root/reports/latest.md', '/volume'),
    ).toBe('/volume/reports/latest.md')
  })

  it('returns the prefix for the root itself', () => {
    expect(virtualPath(CONFIG, '/Volumes/main/default/agent_files/root', '/volume')).toBe('/volume')
  })

  it('rejects backend paths outside the root', () => {
    expect(() =>
      virtualPath(CONFIG, '/Volumes/main/default/other_volume/secret.txt', '/volume'),
    ).toThrow('outside Databricks volume root')
  })
})
