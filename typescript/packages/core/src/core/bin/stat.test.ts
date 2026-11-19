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
import { FileType, PathSpec } from '../../types.ts'
import { renderStub } from './render.ts'
import { stat } from './stat.ts'

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

describe('stat', () => {
  it('a program is an executable file sized to its stub', async () => {
    const st = await stat(accessor(['ls']), spec('/usr/bin/ls'))
    expect(st.type).toBe(FileType.FILE)
    expect(st.mode).toBe(0o755)
    expect(st.size).toBe(renderStub('ls', 'ls is built into mirage.').byteLength)
    expect(st.modified).toBe('2026-11-18T10:00:00Z')
    expect(st.nlink).toBe(1)
  })

  it('the view root is a directory and a miss is ENOENT', async () => {
    const root = await stat(accessor(['ls']), spec('/usr/bin'))
    expect(root.type).toBe(FileType.DIRECTORY)
    expect(root.modified).toBe('2026-11-18T10:00:00Z')
    expect(root.nlink).toBe(2)
    await expect(stat(accessor(['ls']), spec('/usr/bin/cd'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
