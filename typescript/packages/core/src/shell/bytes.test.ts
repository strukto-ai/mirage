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

import { describe, expect, it, vi } from 'vitest'
import { byteChar, decodeText, encodeText } from './bytes.ts'

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

describe('decodeText', () => {
  it('carries one invalid byte as one code unit', () => {
    // A replacing decode reads 0xff as U+FFFD, which is three bytes wide, so
    // every offset past it ran ahead of GNU's.
    expect(decodeText(new Uint8Array([0xff, 0x61]))).toBe('\udcffa')
  })

  it('leaves valid UTF-8 alone', () => {
    expect(decodeText(new TextEncoder().encode('café abc'))).toBe('café abc')
  })

  it('round trips through encodeText', () => {
    const raw = new Uint8Array([0xff, 0x61, 0xc3, 0xa9, 0xfe])
    expect(encodeText(decodeText(raw))).toEqual(raw)
  })
})

it.each([
  [[0xef, 0xbb, 0xbf, 0x61], '\ufeffa'],
  [[0xc0, 0xaf, 0xc1, 0xbf], '\udcc0\udcaf\udcc1\udcbf'],
  [[0xe0, 0x80, 0x80, 0xed, 0xa0, 0x80], '\udce0\udc80\udc80\udced\udca0\udc80'],
  [[0xf0, 0x80, 0x80, 0x80], '\udcf0\udc80\udc80\udc80'],
  [[0xf4, 0x90, 0x80, 0x80, 0xf5, 0xff], '\udcf4\udc90\udc80\udc80\udcf5\udcff'],
  [[0xc2, 0x41, 0xe1, 0x80, 0x42, 0xf0, 0x90, 0x80], '\udcc2A\udce1\udc80B\udcf0\udc90\udc80'],
  [
    [
      0xef, 0xbb, 0xbf, 0xff, 0xc2, 0x80, 0xe0, 0xa0, 0x80, 0xed, 0x9f, 0xbf, 0xf0, 0x90, 0x82,
      0x80, 0xf4, 0x8f, 0xbf, 0xbf,
    ],
    '\ufeff\udcff\u0080\u0800\ud7ff𐂀\u{10ffff}',
  ],
] as const)('decodes UTF-8 boundaries without replacing bytes: %j', (bytes, expected) => {
  const raw = new Uint8Array(bytes)
  expect(decodeText(raw)).toBe(expected)
  expect(encodeText(decodeText(raw))).toEqual(raw)
})

it('decodes a large malformed line with bounded native decoder calls', () => {
  const expected = ('x'.repeat(8190) + '𐂀\udcffé').repeat(4)
  const raw = encodeText(expected)
  const decode = vi.spyOn(TextDecoder.prototype, 'decode')
  try {
    expect(decodeText(raw)).toBe(expected)
    expect(decode.mock.calls.length).toBeLessThanOrEqual(2)
  } finally {
    decode.mockRestore()
  }
})
