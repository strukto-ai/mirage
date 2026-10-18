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

import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { InlineBox } from './box.ts'

it.each([
  ['a/b/c.txt', 'trash', 'trashed'],
  ['a/b', 'trash_ancestor', 'not_found'],
  ['a', 'trash_ancestor', 'not_found'],
] as const)('metadata of trashed %s matches Box', async (deleted, mode, code) => {
  const box = new InlineBox({
    'a/b/c.txt': new TextEncoder().encode('x'),
    'live.txt': new TextEncoder().encode('y'),
  })
  const fid = box.idOf('a/b/c.txt')
  const sibling = box.idOf('live.txt')
  box.delete(deleted, mode)
  const response = await box.fetch(`${box.url}/2.0/files/${fid}`)
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ code })
  expect((await box.fetch(`${box.url}/2.0/files/${sibling}`)).status).toBe(200)
})

it.each(['name', 'size'])('listing projects fields plus Mini: %s', async (fields) => {
  const box = new InlineBox({
    'c.txt': new TextEncoder().encode('x'),
    'folder/child': new TextEncoder().encode('y'),
  })
  const response = await box.fetch(`${box.url}/2.0/folders/0/items?fields=${fields}`)
  const {
    entries: [file, folder],
  } = (await response.json()) as { entries: Record<string, unknown>[] }
  expect(file).toMatchObject({
    name: 'c.txt',
    type: 'file',
    etag: '1',
  })
  expect(typeof file?.sha1).toBe('string')
  expect(typeof file?.id).toBe('string')
  expect(file).not.toHaveProperty('modified_at')
  expect(file != null && 'size' in file).toBe(fields === 'size')
  expect(folder).toMatchObject({ name: 'folder' })
  expect(folder).not.toHaveProperty('sha1')
})

it('fixture wire matches the shared golden', async () => {
  const cases = JSON.parse(
    await readFile(
      new URL('../../../../../../integ/fixtures/box/wire.json', import.meta.url),
      'utf8',
    ),
  ) as { path: string; status: number; body: unknown }[]
  expect(cases.length).toBeGreaterThan(0)
  const box = new InlineBox({ 'a/b/c.txt': new TextEncoder().encode('x') })
  for (const item of cases) {
    const response = await box.fetch(box.url + item.path)
    expect(response.status).toBe(item.status)
    expect(await response.json()).toEqual(item.body)
  }
})
