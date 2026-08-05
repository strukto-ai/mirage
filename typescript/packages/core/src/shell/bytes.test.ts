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
import { byteChar, encodeText } from './bytes.ts'

describe('byteChar / encodeText', () => {
  it('stands for an ASCII byte as itself', () => {
    expect(byteChar(0x41)).toBe('A')
    expect(byteChar(0)).toBe('\0')
    expect([...encodeText(byteChar(0x41))]).toEqual([0x41])
  })

  it('round trips a byte above ASCII', () => {
    expect([...encodeText(byteChar(0xff))]).toEqual([0xff])
    expect([...encodeText(byteChar(0xc3) + byteChar(0xa9))]).toEqual([0xc3, 0xa9])
  })

  it('still encodes ordinary text as UTF-8', () => {
    expect([...encodeText('café\n')]).toEqual([...new TextEncoder().encode('café\n')])
  })

  it('mixes bytes and text', () => {
    expect([...encodeText('a' + byteChar(0xff) + 'b')]).toEqual([0x61, 0xff, 0x62])
  })

  it('keeps the low byte of an octal escape past one byte', () => {
    // bash writes \400 as 0x00 and \777 as 0xff.
    expect([...encodeText(byteChar(0o400))]).toEqual([0x00])
    expect([...encodeText(byteChar(0o777))]).toEqual([0xff])
  })

  it('does not read a non-BMP character as a byte', () => {
    // U+10080 is the surrogate pair D800 DC80, and DC80 is a sentinel
    // only when it stands alone.
    const pair = '\u{10080}'
    expect([...encodeText(pair)]).toEqual([...new TextEncoder().encode(pair)])
    expect([...encodeText('a' + pair + byteChar(0xff))]).toEqual([
      ...new TextEncoder().encode('a' + pair),
      0xff,
    ])
  })
})
