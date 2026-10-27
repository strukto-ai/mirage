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
import { FileType } from '../../types.ts'
import {
  codeOf,
  FakeAccessor,
  FakeStore,
  makeDriver,
  MODIFIED,
  spec,
} from '../../../tests/core/object_store/fakes.ts'
import { makeStat } from './stat.ts'

const accessor = new FakeAccessor()

describe('object_store stat', () => {
  it('maps the driver meta onto FileStat', async () => {
    const store = new FakeStore({ 'a.txt': 'hi' })
    const stat = makeStat(makeDriver(store))
    const st = await stat(accessor, spec('/a.txt'))
    expect(st.size).toBe(2)
    expect(st.modified).toBe(MODIFIED)
    expect(st.fingerprint).toBe('fp-a.txt')
    expect(st.revision).toBe('rev-a.txt')
    expect(st.extra).toEqual({ etag: 'fp-a.txt' })
  })

  it('answers the root as a directory without connecting', async () => {
    const store = new FakeStore()
    const stat = makeStat(makeDriver(store))
    const st = await stat(accessor, spec('/'))
    expect(st.type).toBe(FileType.DIRECTORY)
    expect(store.connects).toBe(0)
  })

  it('answers a prefix as a directory', async () => {
    const store = new FakeStore({ 'dir/f.txt': 'x' })
    const stat = makeStat(makeDriver(store))
    await expect(stat(accessor, spec('/dir'))).resolves.toMatchObject({
      type: FileType.DIRECTORY,
    })
  })

  // Mirrors python's test_stat_names_a_refused_file_as_typed.
  it('names a refused file as typed', async () => {
    const store = new FakeStore({ 'rd/b.txt': 'x' })
    store.refused.add('rd/b.txt')
    const stat = makeStat(makeDriver(store))
    await expect(stat(accessor, spec('/rd/b.txt'))).rejects.toMatchObject({
      code: 'EACCES',
      message: '/mnt/rd/b.txt',
    })
  })

  // Mirrors python's test_stat_names_a_refused_probe. A slashed path skips
  // the head, so only the probe answers.
  it.each([
    [['rd/b.txt', 'rd/b.txt/'], '/rd/b.txt'],
    [['rd/'], '/rd/'],
  ])('names a refused probe: %j', async (refused, path) => {
    const store = new FakeStore({ 'rd/b.txt': 'x' })
    for (const key of refused) store.refused.add(key)
    const stat = makeStat(makeDriver(store))
    await expect(stat(accessor, spec(path))).rejects.toMatchObject({
      code: 'EACCES',
      message: '/mnt' + path,
    })
  })

  // Mirrors python's test_stat_reads_a_refused_key_with_keys_below_as_a_directory.
  it('reads a refused key with keys below as a directory', async () => {
    const store = new FakeStore({ 'rd/a.txt': 'x' })
    store.refused.add('rd')
    const stat = makeStat(makeDriver(store))
    await expect(stat(accessor, spec('/rd'))).resolves.toMatchObject({
      type: FileType.DIRECTORY,
    })
  })

  it('reports ENOENT for a missing path', async () => {
    const stat = makeStat(makeDriver(new FakeStore({ 'a.txt': 'hi' })))
    await expect(codeOf(stat(accessor, spec('/never')))).resolves.toBe('ENOENT')
  })

  it('a trailing slash prefers the coexisting prefix', async () => {
    const store = new FakeStore({ csv: 'file', 'csv/inner.txt': 'x' })
    const stat = makeStat(makeDriver(store))
    const asFile = await stat(accessor, spec('/csv'))
    expect(asFile.type).not.toBe(FileType.DIRECTORY)
    const asDir = await stat(accessor, spec('/csv/'))
    expect(asDir.type).toBe(FileType.DIRECTORY)
  })
})
