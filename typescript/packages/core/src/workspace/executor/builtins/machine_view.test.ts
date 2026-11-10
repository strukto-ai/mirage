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
import { machineScope, optionRefusal, permutedOptions, withMachine } from './machine_view.ts'

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

  it('reads options that follow operands', () => {
    const parse = permutedOptions(SHELL_SPECS.pgrep as never, ['sleep', '-c', '-f'])
    expect(parse.operands).toEqual(['sleep'])
    expect([parse.flags.c, parse.flags.f]).toEqual([true, true])
  })

  it('names the option it refuses', () => {
    const parse = permutedOptions(SHELL_SPECS.top as never, ['-Z'])
    expect(optionRefusal('top', parse, false)).toBe("top: invalid option -- 'Z'\n")
  })

  it('pads to the columns', () => {
    expect(withMachine('ab  ', 'm', 6)).toBe('ab      m')
  })
})
