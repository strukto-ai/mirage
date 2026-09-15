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
import { ansiCEnd, cleanDelimiter, delimiterQuoted } from './delimiter.ts'

describe('cleanDelimiter', () => {
  it.each([
    ['EOF', 'EOF'],
    ["'EOF'", 'EOF'],
    ['"EOF"', 'EOF'],
    ["EN'D'", 'END'],
    ['\\EOF', 'EOF'],
    ['E\\OF', 'EOF'],
    ['E\\$F', 'E$F'],
    ["'EO F'", 'EO F'],
    ["'E\\xF'", 'E\\xF'],
    ["'E\\$F'", 'E\\$F'],
    ['"E\\$F"', 'E$F'],
    ['"E\\"F"', 'E"F'],
    ['"E\\`F"', 'E`F'],
    ['"E\\\\F"', 'E\\F'],
    ['"E\\xF"', 'E\\xF'],
    ["E'", 'E'],
    ["$'EOF'", 'EOF'],
    ["$'E\\tF'", 'E\tF'],
    ["E$'\\t'F", 'E\tF'],
    ["$'E'F", 'EF'],
    ["$'\\''", "'"],
    ['$"EOF"', 'EOF'],
    ['E$"O"F', 'EOF'],
    ["\\$'EOF'", '$EOF'],
    ["'$EOF'", '$EOF'],
    ['"$\'EOF\'"', "$'EOF'"],
    ['$EOF', '$EOF'],
    ['EOF$', 'EOF$'],
    ['EO\\\nF', 'EOF'],
    ['"EO\\\nF"', 'EOF'],
    ['$"EO\\\nF"', 'EOF'],
    ["'EO\\\nF'", 'EO\\\nF'],
    ["$'A\\\nB'", 'A\\\nB'],
  ])('reads %j as %j', (token, expected) => {
    expect(cleanDelimiter(token)).toBe(expected)
  })
})

describe('ansiCEnd', () => {
  it.each([
    ["$'A'", 3],
    ["$'\\''", 4],
    ["$'A", 3],
  ])('closes %j at %i', (token, expected) => {
    expect(ansiCEnd(token, 2)).toBe(expected)
  })
})

describe('delimiterQuoted', () => {
  it.each([
    ['EOF', false],
    ['$EOF', false],
    ["'EOF'", true],
    ['"EOF"', true],
    ["EN'D'", true],
    ['\\EOF', true],
    ['E\\OF', true],
    ["$'EOF'", true],
    ['$"EOF"', true],
    ['EO\\\nF', false],
    ['E\\\nO\\\nF', false],
    ['EO\\\nF\\G', true],
    ['"EO\\\nF"', true],
    ["'EO\\\nF'", true],
  ])('reads %j as quoted %s', (token, quoted) => {
    expect(delimiterQuoted(token)).toBe(quoted)
  })
})
