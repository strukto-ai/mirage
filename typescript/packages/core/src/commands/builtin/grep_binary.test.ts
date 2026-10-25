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
import { specOf } from '../spec/builtins.ts'
import { FlagView } from '../spec/flag_view.ts'
import type { FlagValue } from '../spec/types.ts'
import { parseFlags } from './generic/grep.ts'
import { groupLine, nameEnd, validUtf8 } from './grep_binary.ts'

function flagsOf(flags: Record<string, FlagValue>) {
  return parseFlags(new FlagView(flags, specOf('grep')))
}

// Twin of test_grep_binary.py.
describe('grep output framing', () => {
  it.each<[Record<string, FlagValue>, string]>([
    [{}, ''],
    [{ after_context: '0' }, '--\n'],
    [{ context: '1', group_separator: '==' }, '==\n'],
    [{ context: '1', no_group_separator: true }, ''],
    [{ context: '1', count: true }, ''],
  ])('separates groups only where lines print with context: %j', (flags, line) => {
    // grep 3.11: -A0 still separates groups; -c prints no lines to separate.
    expect(groupLine(flagsOf(flags))).toBe(line)
  })

  it('ends a listed name in NUL under -Z', () => {
    expect(nameEnd(flagsOf({}))).toBe('\n')
    expect(nameEnd(flagsOf({ null: true }))).toBe('\0')
  })

  it('reads a stray byte as not UTF-8', () => {
    expect(validUtf8(new TextEncoder().encode('é'))).toBe(true)
    expect(validUtf8(new Uint8Array([0x61, 0xff, 0x62]))).toBe(false)
  })
})
