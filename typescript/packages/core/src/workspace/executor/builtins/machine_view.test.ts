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
import { SHELL_SPECS } from '../../../commands/spec/shell.ts'
import { ProcessTable } from '../../../execution/process/table.ts'
import {
  inScope,
  machineScope,
  optionRefusal,
  permutedOptions,
  processScope,
  withMachine,
} from './machine_view.ts'

function table(...ids: string[]): ProcessTable {
  const processes = new ProcessTable({ workspaceId: 'w' } as never)
  processes.machineIds = () => ids
  return processes
}

describe('machine view', () => {
  it('answers for every machine without a name', () => {
    const scope = machineScope(table('docker:a', 'e2b:b'), null)
    expect(scope).toEqual({
      ids: ['docker:a', 'e2b:b'],
      picked: false,
      several: true,
      workspace: false,
    })
  })

  it('picks one by name or id', () => {
    const processes = table('docker:a', 'e2b:b')
    expect(machineScope(processes, 'b')).toEqual({
      ids: ['e2b:b'],
      picked: true,
      several: false,
      workspace: false,
    })
    expect(machineScope(processes, 'e2b:b')).toEqual({
      ids: ['e2b:b'],
      picked: true,
      several: false,
      workspace: false,
    })
  })

  it('picks none for an unknown name', () => {
    expect(machineScope(table('docker:a'), 'nosuch')).toBeNull()
  })

  it('is empty without machines', () => {
    expect(machineScope(table(), null)).toEqual({
      ids: [],
      picked: false,
      several: false,
      workspace: false,
    })
  })

  it('lets the workspace answer ahead of one machine', () => {
    expect(machineScope(table('docker:a'), null, true)).toEqual({
      ids: ['docker:a'],
      picked: false,
      several: true,
      workspace: true,
    })
  })

  it('keeps the workspace alone to one row', () => {
    expect(machineScope(table(), null, true)).toEqual({
      ids: [],
      picked: false,
      several: false,
      workspace: true,
    })
  })

  it('takes mirage as the workspace only where it answers', () => {
    const processes = table('docker:a')
    expect(machineScope(processes, 'mirage', true)).toEqual({
      ids: [],
      picked: true,
      several: false,
      workspace: true,
    })
    expect(machineScope(processes, 'mirage')).toBeNull()
  })

  it("takes mirage as Mirage's own for a process search", () => {
    const processes = table('docker:a')
    expect(processScope(processes, 'mirage')).toEqual({
      ids: [],
      picked: true,
      several: false,
      workspace: true,
    })
    expect(processScope(processes, 'a')?.ids).toEqual(['docker:a'])
    expect(processScope(processes, 'nosuch')).toBeNull()
  })

  it("keeps Mirage's own in scope unless another machine is picked", () => {
    const one = { ids: ['docker:a'], picked: false, several: false, workspace: false }
    expect(inScope(one, 'mirage')).toBe(true)
    expect(inScope(one, 'docker:a')).toBe(true)
    expect(inScope({ ...one, picked: true }, 'mirage')).toBe(false)
    const own = { ids: [], picked: true, several: false, workspace: true }
    expect(inScope(own, 'mirage')).toBe(true)
    expect(inScope(own, 'docker:a')).toBe(false)
  })

  it('reads options that follow operands', () => {
    const parse = permutedOptions(SHELL_SPECS.pgrep as never, ['sleep', '-c', '-f'])
    expect(parse.operands).toEqual(['sleep'])
    expect([parse.flags.c, parse.flags.f]).toEqual([true, true])
  })

  it('reads every word after a double dash as an operand', () => {
    const named = permutedOptions(SHELL_SPECS.killall as never, ['--', 'sleep', '--signal', 'KILL'])
    expect(named.operands).toEqual(['sleep', '--signal', 'KILL'])
    expect(named.flags.s).toBeUndefined()
    const later = permutedOptions(SHELL_SPECS.pgrep as never, ['sleep', '--', '-c'])
    expect(later.operands).toEqual(['sleep', '-c'])
    expect(later.flags.c).toBeUndefined()
  })

  it('keeps a double dash an option takes as its value', () => {
    const parse = permutedOptions(SHELL_SPECS.pgrep as never, ['-d', '--', 'sleep', '-c'])
    expect(parse.operands).toEqual(['sleep'])
    expect([parse.flags.d, parse.flags.c]).toEqual(['--', true])
  })

  it('names the option it refuses', () => {
    const parse = permutedOptions(SHELL_SPECS.top as never, ['-Z'])
    expect(optionRefusal('top', parse, false)).toBe("top: invalid option -- 'Z'\n")
  })

  it('pads to the columns', () => {
    expect(withMachine('ab  ', 'm', 6)).toBe('ab      m')
  })
})
