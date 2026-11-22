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
import { failed, ok, ScriptedMachine } from '../../../tests/fixtures/machine.ts'
import { bound, spec } from '../../../tests/fixtures/machine_files.ts'
import { copy, dirCopy } from './copy.ts'
import { mkdir } from './mkdir.ts'
import { rename } from './rename.ts'
import { rmR } from './rm.ts'
import { rmdir } from './rmdir.ts'
import { unlink } from './unlink.ts'

describe('tree ops', () => {
  it('run one line each', async () => {
    const machine = new ScriptedMachine('box', () => ok('copied\n'))
    const accessor = bound([machine])
    await mkdir(accessor, 'box', spec('/d'), true)
    await unlink(accessor, 'box', spec('/f'))
    await rmdir(accessor, 'box', spec('/d'))
    await rmR(accessor, 'box', spec('/t'))
    await rename(accessor, 'box', spec('/a'), spec('/b/c'), true)
    await copy(accessor, 'box', spec('/a'), spec('/b'))
    await dirCopy(accessor, 'box', spec('/s'), spec('/t'))
    await copy(accessor, 'box', spec('/a'), spec('/n/b'), true)
    await dirCopy(accessor, 'box', spec('/s'), spec('/n/t'), true)
    expect(machine.lines).toEqual([
      "mkdir -p -- '/tmp/d'",
      "rm -- '/tmp/f'",
      "rmdir -- '/tmp/d'",
      "rm -r -- '/tmp/t'",
      "mkdir -p -- '/tmp/b' && mv -T -- '/tmp/a' '/tmp/b/c'",
      "cp -T -- '/tmp/a' '/tmp/b'",
      "env LC_ALL=C cp -RL -- '/tmp/s' '/tmp/t' && echo copied",
      "mkdir -p -- '/tmp/n' && cp -T -- '/tmp/a' '/tmp/n/b'",
      "mkdir -p -- '/tmp/n' && env LC_ALL=C cp -RL -- '/tmp/s' '/tmp/n/t' && echo copied",
    ])
  })

  it.each([
    ["rmdir: failed to remove '/tmp/d': Directory not empty\n", 'ENOTEMPTY'],
    ["mkdir: cannot create directory '/tmp/d': File exists\n", 'EEXIST'],
    ["rm: cannot remove '/tmp/d': Is a directory\n", 'EISDIR'],
  ])('keeps the errno of %j', async (said, code) => {
    const machine = new ScriptedMachine('box', () => failed(said))
    await expect(rmdir(bound([machine]), 'box', spec('/d'))).rejects.toMatchObject({
      code,
      virtualPath: '/tmp/d',
    })
  })
})
