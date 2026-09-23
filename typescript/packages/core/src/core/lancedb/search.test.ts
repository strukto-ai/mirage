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

import { expect, it } from 'vitest'

import { LanceDBAccessor } from '../../accessor/lancedb.ts'
import { resolveLanceDBConfig } from '../../vfs/lancedb/config.ts'
import { PathSpec } from '../../types.ts'
import type { LanceDriver } from './_driver.ts'
import { searchRowsOutput } from './search.ts'

it('spells a group value in the canonical path the way the listing does', async () => {
  // A path the listing never shows is one `cat` cannot open: the group
  // segment renders the way readdir renders it, escape lead and all.
  const config = resolveLanceDBConfig({
    uri: '/tmp/db',
    groupBy: ['label'],
    idColumn: 'id',
    titleColumn: 'name',
    textColumn: 'name',
  })
  const driver = {
    search: () =>
      Promise.resolve([
        { id: 1, label: 'a/b', name: 'one', _distance: 0.1 },
        { id: 2, label: '', name: 'two', _distance: 0.2 },
        { id: 3, label: '.env', name: 'three', _distance: 0.3 },
      ]),
  } as unknown as LanceDriver
  const accessor = new LanceDBAccessor(driver, config)
  const path = new PathSpec({ virtual: '/db/docs', directory: '/db/docs', vfsPath: 'docs' })
  const output = new TextDecoder().decode(
    await searchRowsOutput(accessor, 'one', [path], 3, 0, '/db'),
  )
  const headers = output.split('\n').filter((line) => line.startsWith('/db/'))
  expect(headers).toEqual([
    '/db/docs/a∕b/1.md:0.1000',
    '/db/docs/⁄/2.md:0.2000',
    '/db/docs/⁄.env/3.md:0.3000',
  ])
})
