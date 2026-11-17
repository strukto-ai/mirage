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
import { failed, ok, ScriptedMachine, tableOf } from '../../tests/fixtures/machine.ts'
import { MachineAccessor } from './machine.ts'

const DEC = new TextDecoder()

function decoded(answer: [number | null, Uint8Array, Uint8Array]): [number | null, string, string] {
  return [answer[0], DEC.decode(answer[1]), DEC.decode(answer[2])]
}

describe('MachineAccessor', () => {
  it('answers a line with its status, output and errors', async () => {
    const machine = new ScriptedMachine('box', () => failed('no\n', 2))
    const accessor = new MachineAccessor({})
    accessor.bindMachines(tableOf(machine), 'box')
    expect(decoded(await accessor.run('box', 'true'))).toEqual([2, '', 'no\n'])
    expect(machine.lines).toEqual(['true'])
  })

  it("gives a merged exec's failing output as its errors", async () => {
    const machine = new ScriptedMachine('box', () => failed('cat: x: gone\n'), true, true)
    const accessor = new MachineAccessor({})
    accessor.bindMachines(tableOf(machine), 'box')
    expect(decoded(await accessor.run('box', 'cat x'))).toEqual([1, '', 'cat: x: gone\n'])
  })

  it('says so when unbound', () => {
    expect(() => new MachineAccessor({}).names()).toThrow('not bound to machines')
  })

  it('follows the config or every machine', () => {
    const a = new ScriptedMachine('a', () => ok())
    const b = new ScriptedMachine('b', () => ok())
    const every = new MachineAccessor({})
    every.bindMachines(tableOf(a, b), 'b')
    expect([every.names(), every.defaultMachine]).toEqual([['a', 'b'], 'b'])
    const one = new MachineAccessor({ machines: ['b'] })
    one.bindMachines(
      tableOf(new ScriptedMachine('a', () => ok()), new ScriptedMachine('b', () => ok())),
      'a',
    )
    expect([one.names(), one.defaultMachine]).toEqual([['b'], 'b'])
  })
})
