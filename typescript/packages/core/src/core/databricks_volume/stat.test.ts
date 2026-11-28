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
  FILES,
  ROOT,
  spec,
} from '../../../tests/fixtures/databricks_volume.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { type FileStat, FileType } from '../../types.ts'
import { exists } from './exists.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

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

// The mount answers a stat from the row the listing names, so a row and the
// backend's own stat of the path must agree. Mirrors Python's
// test_a_listed_*_row_matches_its_stat.
describe('a listed row', () => {
  it('matches the stat of a file', async () => {
    await volume.put(`${ROOT}/reports/a.txt`, 'abcdef')
    const [row] = (await readdir(volume.accessor(), spec('/volume/reports'))) as FileStat[]
    expect(row).toEqual(await stat(volume.accessor(), spec('/volume/reports/a.txt')))
  })

  it('matches the stat of a file written between whole seconds', async () => {
    await volume.put(`${ROOT}/reports/a.txt`, 'abcdef')
    await volume.setModified(`${ROOT}/reports/a.txt`, 1_700_000_000_750)
    // The listing names the write to the millisecond, HEAD only to the
    // second, so a row that kept the milliseconds would differ from the
    // stat of the same file.
    const listed = await volume.listing(`${ROOT}/reports`)
    expect(listed.contents.map((entry) => entry.last_modified)).toEqual([1_700_000_000_750])
    const [row] = (await readdir(volume.accessor(), spec('/volume/reports'))) as FileStat[]
    expect(row?.modified).toBe('2023-11-14T22:13:20Z')
    expect(row).toEqual(await stat(volume.accessor(), spec('/volume/reports/a.txt')))
  })

  it('matches the stat of a directory', async () => {
    await volume.mkdir(`${ROOT}/reports/sub`)
    const [row] = (await readdir(volume.accessor(), spec('/volume/reports'))) as FileStat[]
    expect(row?.type).toBe(FileType.DIRECTORY)
    expect(row).toEqual(await stat(volume.accessor(), spec('/volume/reports/sub')))
  })
})

describe('stat', () => {
  it('returns file metadata from HEAD headers', async () => {
    await volume.put(`${ROOT}/reports/a.txt`, 'x'.repeat(42))
    await volume.setModified(`${ROOT}/reports/a.txt`, Date.parse('2026-06-10T01:02:03Z'))
    await volume.run.recordRequests()
    const st = await stat(volume.accessor(), spec('/volume/reports/a.txt'))
    expect(st.name).toBe('a.txt')
    expect(st.size).toBe(42)
    expect(st.modified).toBe('2026-06-10T01:02:03Z')
    expect(st.type).not.toBe(FileType.DIRECTORY)
    expect(await volume.asked('HEAD', FILES)).toEqual([`${ROOT}/reports/a.txt`])
  })

  it('falls back to directory metadata on file 404', async () => {
    await volume.mkdir(`${ROOT}/reports`)
    await volume.run.recordRequests()
    const st = await stat(volume.accessor(), spec('/volume/reports'))
    expect(st.name).toBe('reports')
    expect(st.type).toBe(FileType.DIRECTORY)
    expect((await volume.run.requests()).map((r) => r.split(' ')[0])).toEqual(['HEAD', 'HEAD'])
    expect(await volume.asked('HEAD', DIRS)).toEqual([`${ROOT}/reports`])
  })

  it('raises ENOENT when neither file nor directory exists', async () => {
    const err = (await stat(volume.accessor(), spec('/volume/gone')).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('ENOENT')
  })

  it('returns a directory stat for the mount root without any request', async () => {
    await volume.run.recordRequests()
    const st = await stat(volume.accessor(), spec('/volume/'))
    expect(st.name).toBe('/')
    expect(st.type).toBe(FileType.DIRECTORY)
    expect(await volume.run.requests()).toEqual([])
  })
})

describe('exists', () => {
  it('maps stat success and ENOENT to booleans', async () => {
    await volume.put(`${ROOT}/a.txt`, 'x')
    expect(await exists(volume.accessor(), spec('/volume/a.txt'))).toBe(true)
    expect(await exists(volume.accessor(), spec('/volume/gone.txt'))).toBe(false)
  })
})
