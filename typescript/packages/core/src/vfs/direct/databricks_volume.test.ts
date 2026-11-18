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
import { DatabricksVolumeConfig } from '../databricks_volume/config.ts'
import { parseConfigWithSchema } from '../secrets.ts'
import { DatabricksVolumeVFS } from './databricks_volume.ts'

const MINIMAL = {
  catalog: 'main',
  schema: 'default',
  volume: 'agent_files',
  host: 'HTTPS://DBC.EXAMPLE.COM:443/',
  token: 't',
}

describe('DatabricksVolumeVFS.create', () => {
  it('applies the documented defaults to the minimal config', async () => {
    const vfs = await DatabricksVolumeVFS.create(MINIMAL)
    expect(vfs.config.rootPath).toBe('/')
    expect(vfs.config.host).toBe('https://dbc.example.com')
  })

  it('takes a token provider as the docs show', async () => {
    const vfs = await DatabricksVolumeVFS.create({
      ...MINIMAL,
      token: () => Promise.resolve('fresh'),
    })
    expect(typeof vfs.config.token).toBe('function')
  })

  it('keeps a config the registry already parsed unchanged', async () => {
    const once = parseConfigWithSchema(DatabricksVolumeConfig, { ...MINIMAL, root_path: 'r/./s/' })
    const vfs = await DatabricksVolumeVFS.create(once)
    expect(vfs.config).toEqual(once)
    expect(vfs.config.rootPath).toBe('/r/s')
  })
})
