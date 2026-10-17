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
import { PathSpec } from '../../../types.ts'
import type { CommandIO } from '../../config.ts'
import { isDirOf } from './archive_io.ts'

const accessor = {} as never
const DIR = PathSpec.fromStrPath('/d')

function ops(stat: CommandIO['stat'], readdir: CommandIO['readdir']): CommandIO {
  return {
    readdir,
    readBytes: () => Promise.reject(new Error('not used')),
    readStream: () => {
      throw new Error('not used')
    },
    stat,
    isMounted: () => true,
  }
}

const missingStat: CommandIO['stat'] = (_a, p) => Promise.reject(enoent(p))
const listing: CommandIO['readdir'] = (_a, p) => Promise.resolve([`${p.virtual}/a`])

describe('isDirOf', () => {
  it('asks the listing after a stat miss', async () => {
    await expect(isDirOf(ops(missingStat, listing), accessor, undefined)(DIR)).resolves.toBe(true)
  })

  it('answers no when both channels miss', async () => {
    const missing: CommandIO['readdir'] = (_a, p) => Promise.reject(enoent(p))
    await expect(isDirOf(ops(missingStat, missing), accessor, undefined)(DIR)).resolves.toBe(false)
  })

  it('lets a refused stat through', async () => {
    const refused: CommandIO['stat'] = (_a, p) => Promise.reject(eacces(p.virtual))
    await expect(isDirOf(ops(refused, listing), accessor, undefined)(DIR)).rejects.toMatchObject({
      code: 'EACCES',
    })
  })
})
