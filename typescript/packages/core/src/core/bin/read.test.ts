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
import { read } from './read.ts'
import { renderStub } from './render.ts'

function accessor(names: string[]): BinAccessor {
  return new BinAccessor(
    () => names,
    (name) => (names.includes(name) ? `${name} is built into mirage.` : null),
    '2026-11-18T10:00:00Z',
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

describe('read', () => {
  it("renders a program's stub", async () => {
    expect(await read(accessor(['cat', 'ls']), spec('/usr/bin/ls'))).toEqual(
      renderStub('ls', 'ls is built into mirage.'),
    )
  })

  it('refuses the view root and a name that runs nothing', async () => {
    await expect(read(accessor(['ls']), spec('/usr/bin'))).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(read(accessor(['ls']), spec('/usr/bin/cd'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(read(accessor(['ls']), spec('/usr/bin/ls/x'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
