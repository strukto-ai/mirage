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
import { parseConfigWithSchema } from '../secrets.ts'
import { TiDBFilesystemConfig } from '../tidb_filesystem/config.ts'
import { TiDBFilesystemVFS } from './tidb_filesystem.ts'

describe('TiDBFilesystemVFS.create', () => {
  it('applies the documented defaults to the minimal config', async () => {
    const vfs = await TiDBFilesystemVFS.create({ host: 'https://drive9.example/', token: 't' })
    expect(vfs.config.rootPath).toBe('/')
    expect(vfs.config.host).toBe('https://drive9.example')
  })

  it('keeps a config the registry already parsed unchanged', async () => {
    const once = parseConfigWithSchema(TiDBFilesystemConfig, {
      host: 'https://drive9.example/',
      token: 't',
      root_path: 'a/./b/',
    })
    const vfs = await TiDBFilesystemVFS.create(once)
    expect(vfs.config).toEqual(once)
    expect(vfs.config.rootPath).toBe('/a/b')
  })
})
