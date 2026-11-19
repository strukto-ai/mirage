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
import { CAPTURABLE_BUILTINS, PROGRAM_LOOKUPS, PROGRAM_WRAPPERS } from './constants.ts'
import { ProgramLookup } from './types.ts'

describe('PROGRAM_LOOKUPS', () => {
  it('names a command and the question each row asks', () => {
    const ask = (command: string, option: string): ProgramLookup | undefined =>
      PROGRAM_LOOKUPS.get(command)?.get(option)
    expect(ask('which', '')).toBe(ProgramLookup.PATH)
    expect(ask('type', '-P')).toBe(ProgramLookup.PATH)
    expect(ask('command', '-v')).toBe(ProgramLookup.PATH)
    expect(ask('type', '')).toBe(ProgramLookup.KIND)
    expect(ask('command', '-V')).toBe(ProgramLookup.KIND)
    const exists = [...PROGRAM_LOOKUPS]
      .filter(([, rows]) => [...rows.values()].includes(ProgramLookup.EXISTS))
      .map(([command]) => command)
    expect(new Set(exists)).toEqual(
      new Set(['exec', 'find', 'xargs', 'timeout', 'env', ...PROGRAM_WRAPPERS.keys()]),
    )
    expect(CAPTURABLE_BUILTINS.has('which')).toBe(true)
  })
})
