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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  DatabricksVolume,
  DIRS,
  DIRS_PREFIX,
  FILES,
  ROOT,
  spec,
} from '../../../tests/fixtures/databricks_volume.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { DirListing, type FileStat, FileType } from '../../types.ts'
import { readdir } from './readdir.ts'

let origin = ''
let volume: DatabricksVolume

beforeAll(async () => {
  origin = await serve('databricks')
})

beforeEach(async () => {
  volume = new DatabricksVolume(origin)
  await volume.reset()
})

afterEach(async () => {
  await volume.run.close()
})

// A listing's first page as Databricks answers one with more to come: the
// fake lists a directory on one page, so a test that needs two arms the first.
async function firstPage(...names: string[]): Promise<void> {
  await volume.run.answerNext(
    'GET',
    DIRS,
    200,
    {
      contents: names.map((name) => ({ path: `${ROOT}/${name}`, name, file_size: 1 })),
      next_page_token: 'next',
    },
    1,
    `${DIRS_PREFIX}${ROOT}`,
    '',
  )
}

describe('readdir', () => {
  it('lists sorted rows named without trailing slashes', async () => {
    await volume.put(`${ROOT}/b.txt`, 'bb')
    await volume.mkdir(`${ROOT}/a`)
    const rows = (await readdir(volume.accessor(), spec('/volume/'))) as FileStat[]
    expect(rows.map((row) => [row.name, row.type])).toEqual([
      ['a', FileType.DIRECTORY],
      ['b.txt', FileType.FILE],
    ])
  })

  it('follows next_page_token pagination', async () => {
    await volume.put(`${ROOT}/b.txt`, 'b')
    await firstPage('a.txt')
    await volume.run.recordRequests()
    const rows = (await readdir(volume.accessor(), spec('/volume/'))) as FileStat[]
    expect(rows.map((row) => row.name)).toEqual(['a.txt', 'b.txt'])
    expect(await volume.run.params('GET', DIRS)).toEqual([{}, { page_token: 'next' }])
  })

  it('pages no further than a limit and marks the listing partial', async () => {
    await volume.put(`${ROOT}/b.txt`, 'b')
    await firstPage('a.txt')
    await volume.run.recordRequests()
    const cut = await readdir(volume.accessor(), spec('/volume/'), 1)
    expect(cut).toBeInstanceOf(DirListing)
    expect((cut as DirListing).partial).toBe(true)
    expect((cut as DirListing).entries.map((row) => row.name)).toEqual(['a.txt'])
    expect(await volume.asked('GET', DIRS)).toHaveLength(1)
  })

  it('raises ENOENT for missing directories', async () => {
    const err = (await readdir(volume.accessor(), spec('/volume/missing')).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('ENOENT')
  })

  it('reports ENOTDIR for an operand under a file', async () => {
    // The Files API 404s `/a.txt/x` exactly as it does a name that is simply
    // absent, so only the ancestor walk can tell GNU's "Not a directory"
    // from "No such file or directory".
    await volume.put(`${ROOT}/a.txt`, 'abc')
    const err = (await readdir(volume.accessor(), spec('/volume/a.txt/x')).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('ENOTDIR')
  })

  it('settles a file operand on one probe, without walking its ancestors', async () => {
    await volume.put(`${ROOT}/docs/a.txt`, 'abc')
    await volume.run.recordRequests()
    const err = (await readdir(volume.accessor(), spec('/volume/docs/a.txt')).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('ENOTDIR')
    expect(await volume.asked('HEAD', FILES)).toEqual([`${ROOT}/docs/a.txt`])
    expect(await volume.asked('HEAD', DIRS)).toEqual([])
  })

  it('answers each child with its size, type and modified time', async () => {
    await volume.put(`${ROOT}/a.txt`, 'abcdef')
    await volume.mkdir(`${ROOT}/d`)
    await volume.setModified(`${ROOT}/a.txt`, 1_700_000_000_000)
    const [file, dir] = (await readdir(volume.accessor(), spec('/volume/'))) as FileStat[]
    expect([file?.type, file?.size, file?.modified]).toEqual([
      FileType.FILE,
      6,
      '2023-11-14T22:13:20Z',
    ])
    expect(dir?.type).toBe(FileType.DIRECTORY)
  })

  it('backfills a lister-omitted size with one HEAD', async () => {
    // The fake's listings leave out poem.txt's size.
    await volume.put(`${ROOT}/poem.txt`, 'roses r')
    await volume.put(`${ROOT}/b.txt`, 'abc')
    await volume.run.recordRequests()
    const rows = (await readdir(volume.accessor(), spec('/volume/'))) as FileStat[]
    expect(rows.map((row) => [row.name, row.size])).toEqual([
      ['b.txt', 3],
      ['poem.txt', 7],
    ])
    expect(await volume.asked('HEAD', FILES)).toEqual([`${ROOT}/poem.txt`])
  })

  it('interprets early-epoch listing timestamps as milliseconds', async () => {
    await volume.put(`${ROOT}/early.txt`, 'x')
    await volume.setModified(`${ROOT}/early.txt`, 1000)
    const [file] = (await readdir(volume.accessor(), spec('/volume/'))) as FileStat[]
    expect(file?.modified).toBe('1970-01-01T00:00:01Z')
  })
})
