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
import { ScriptedMachine } from '../../../tests/fixtures/machine.ts'
import { bound, holding, spec } from '../../../tests/fixtures/machine_files.ts'
import { currentCaller, bindCaller } from '../../context/session_context.ts'
import { MachineName } from '../../execution/types.ts'
import { holder, holders, lands, stage } from './place.ts'

function runningOn<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return bindCaller({ ...currentCaller(), machine: new MachineName('scripted', name) }, fn)
}

describe('placement', () => {
  it('asks nothing on one machine', async () => {
    const machine = new ScriptedMachine('box', holding())
    const accessor = bound([machine])
    expect(await holders(accessor, spec('/x'))).toEqual(['box'])
    expect(await lands(accessor, spec('/x'))).toBe('box')
    expect(machine.lines).toEqual([])
  })

  it('reads a name where it is', async () => {
    const accessor = bound([
      new ScriptedMachine('a', holding()),
      new ScriptedMachine('b', holding('/tmp/out.csv')),
    ])
    expect(await holder(accessor, spec('/out.csv'))).toBe('b')
    await expect(holder(accessor, spec('/none'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it("takes a name on two machines from the running program's, else refuses it", async () => {
    const accessor = bound([
      new ScriptedMachine('a', holding('/tmp/x')),
      new ScriptedMachine('b', holding('/tmp/x')),
    ])
    await expect(holder(accessor, spec('/x'))).rejects.toThrow('on several machines: a, b')
    await runningOn('b', async () => {
      expect(stage(accessor)).toBe('b')
      expect(await holder(accessor, spec('/x'))).toBe('b')
    })
  })

  it("lands a new name on the program's machine, else the default", async () => {
    const accessor = bound([
      new ScriptedMachine('a', holding()),
      new ScriptedMachine('b', holding()),
    ])
    expect(accessor.defaultMachine).toBe('a')
    expect(await lands(accessor, spec('/new'))).toBe('a')
    await runningOn('b', async () => {
      expect(await lands(accessor, spec('/new'))).toBe('b')
    })
  })

  it('writes an existing name where it is', async () => {
    const accessor = bound([
      new ScriptedMachine('a', holding()),
      new ScriptedMachine('b', holding('/tmp/kept')),
    ])
    await runningOn('a', async () => {
      expect(await lands(accessor, spec('/kept'))).toBe('b')
    })
  })

  it('lets a configured default machine win', () => {
    const accessor = bound(
      [new ScriptedMachine('a', holding()), new ScriptedMachine('b', holding())],
      {
        defaultMachine: 'b',
      },
    )
    expect(accessor.defaultMachine).toBe('b')
  })

  it('refuses a mount naming no such machine', () => {
    expect(() => bound([new ScriptedMachine('a', holding())], { machines: ['gpu'] })).toThrow(
      "unknown machine: 'gpu'",
    )
  })
})
