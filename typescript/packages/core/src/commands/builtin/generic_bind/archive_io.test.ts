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
import { eacces, enoent } from '../../../errors/fs.ts'
import type { FileStat, PathSpec } from '../../../types.ts'
import { PathSpec as Path } from '../../../types.ts'
import { isDirOf } from './archive_io.ts'
import type { CommandFiles } from './files.ts'

const DIR = Path.fromStrPath('/d')

type Stat = (p: PathSpec) => Promise<FileStat>
type Readdir = (p: PathSpec) => Promise<string[]>

function files(stat: Stat, readdir: Readdir): CommandFiles {
  return { stat, readdir } as unknown as CommandFiles
}

const missingStat: Stat = (p) => Promise.reject(enoent(p))
const listing: Readdir = (p) => Promise.resolve([`${p.virtual}/a`])

describe('isDirOf', () => {
  it('asks the listing after a stat miss', async () => {
    await expect(isDirOf(files(missingStat, listing))(DIR)).resolves.toBe(true)
  })

  it('answers no when both channels miss', async () => {
    const missing: Readdir = (p) => Promise.reject(enoent(p))
    await expect(isDirOf(files(missingStat, missing))(DIR)).resolves.toBe(false)
  })

  it('lets a refused stat through', async () => {
    const refused: Stat = (p) => Promise.reject(eacces(p.virtual))
    await expect(isDirOf(files(refused, listing))(DIR)).rejects.toMatchObject({
      code: 'EACCES',
    })
  })
})
