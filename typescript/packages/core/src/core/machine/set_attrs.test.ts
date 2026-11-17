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
import { ok, ScriptedMachine } from '../../../tests/fixtures/machine.ts'
import { bound, spec } from '../../../tests/fixtures/machine_files.ts'
import { CapacityState, PathSpec } from '../../types.ts'
import { capacity } from './capacity.ts'
import { attrsCommand, setAttrs } from './set_attrs.ts'

describe('attrsCommand', () => {
  it('sets every field asked', () => {
    expect(attrsCommand('/t/x', {})).toBeNull()
    expect(
      attrsCommand('/t/x', {
        mode: 0o640,
        uid: 'app',
        gid: 'staff',
        mtime: '2024-01-01T00:00:00+00:00',
      }),
    ).toBe(
      "chmod 640 -- '/t/x' && chown 'app:staff' -- '/t/x' && touch -c -m -d @1704067200 -- '/t/x'",
    )
    expect(attrsCommand('/t/x', { gid: 7 })).toBe("chgrp '7' -- '/t/x'")
  })
})

describe('setAttrs', () => {
  it('leaves nothing to an overlay', async () => {
    const machine = new ScriptedMachine('box', () => ok())
    expect(await setAttrs(bound([machine]), 'box', spec('/x'), { mode: 0o600 })).toEqual({})
    expect(machine.lines).toEqual(["chmod 600 -- '/tmp/x'"])
  })
})

describe('capacity', () => {
  it('reads df', async () => {
    const out =
      'Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 100 40 60 40% /\n'
    const machine = new ScriptedMachine('box', () => ok(out))
    expect(await capacity(bound([machine]), PathSpec.fromStrPath('/'))).toEqual({
      state: CapacityState.QUOTA,
      total: 102400,
      used: 40960,
      available: 61440,
    })
    const odd = new ScriptedMachine('odd', () => ok('what\n'))
    expect((await capacity(bound([odd]), PathSpec.fromStrPath('/'))).state).toBe(
      CapacityState.UNKNOWN,
    )
  })
})
