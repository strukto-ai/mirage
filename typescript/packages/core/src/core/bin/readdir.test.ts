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
import { BinAccessor } from '../../accessor/bin.ts'
import { PathSpec } from '../../types.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

function accessor(names: string[]): BinAccessor {
  return new BinAccessor(
    () => names,
    (name) => (names.includes(name) ? `${name} is built into mirage.` : null),
  )
}

function spec(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resolved: false,
    vfsPath: path.slice('/usr/bin'.length),
  })
}

describe('readdir', () => {
  it('lists one row per program, as its stat answers it', async () => {
    const programs = accessor(['cat', 'ls'])
    const rows = await readdir(programs, spec('/usr/bin'))
    expect(rows.map((row) => row.name)).toEqual(['cat', 'ls'])
    expect(rows[1]).toEqual(await stat(programs, spec('/usr/bin/ls')))
  })

  it('of a program is not a directory', async () => {
    await expect(readdir(accessor(['ls']), spec('/usr/bin/ls'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
    await expect(readdir(accessor(['ls']), spec('/usr/bin/cd'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
