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

import { isUnsatisfiableRange, rangeHeader, sliceWindow } from './ranges.js'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const DATA = ENC.encode('0123456789')

describe('rangeHeader', () => {
  it('needs no header for the whole file', () => {
    expect(rangeHeader(0, null)).toBeNull()
  })

  it('is inclusive at both ends of a bounded window', () => {
    // HTTP ranges name the last byte, not the one after it, so a 4-byte window
    // from 2 ends at 5.
    expect(rangeHeader(2, 4)).toBe('bytes=2-5')
  })

  it('leaves the end blank on an open-ended window', () => {
    expect(rangeHeader(7, null)).toBe('bytes=7-')
  })

  it('names the same offset twice for a single byte', () => {
    expect(rangeHeader(3, 1)).toBe('bytes=3-3')
  })

  it('refuses a negative offset', () => {
    expect(() => rangeHeader(-1, 4)).toThrow(RangeError)
  })

  it('refuses a negative size', () => {
    expect(() => rangeHeader(0, -4)).toThrow(RangeError)
  })

  it('refuses a zero-length window', () => {
    // bytes=2--1 is malformed and no header means the opposite of what was
    // asked, so the caller has to short-circuit instead.
    expect(() => rangeHeader(2, 0)).toThrow(RangeError)
  })
})

describe('sliceWindow', () => {
  it('slices a bounded window', () => {
    expect(DEC.decode(sliceWindow(DATA, 2, 4))).toBe('2345')
  })

  it('slices to the end', () => {
    expect(DEC.decode(sliceWindow(DATA, 7, null))).toBe('789')
  })

  it('slices the whole thing', () => {
    expect(sliceWindow(DATA, 0, null)).toEqual(DATA)
  })

  it('stops at the end when the window runs past it', () => {
    expect(DEC.decode(sliceWindow(DATA, 8, 99))).toBe('89')
  })

  it('is empty from past the end', () => {
    expect(sliceWindow(DATA, 99, 4)).toEqual(new Uint8Array(0))
  })
})

describe('isUnsatisfiableRange', () => {
  // The point of the predicate: a POSIX read at or past EOF is empty, an HTTP
  // store answers 416, and no two clients spell the refusal the same way.
  it('recognizes the aws sdk shape', () => {
    const err = Object.assign(new Error('InvalidRange'), {
      name: 'InvalidRange',
      $metadata: { httpStatusCode: 416 },
    })
    expect(isUnsatisfiableRange(err)).toBe(true)
  })

  it('recognizes a bare status, with no code at all', () => {
    expect(isUnsatisfiableRange({ status: 416 })).toBe(true)
    expect(isUnsatisfiableRange({ statusCode: 416 })).toBe(true)
  })

  it('recognizes the code without a status', () => {
    expect(isUnsatisfiableRange(Object.assign(new Error('nope'), { Code: 'InvalidRange' }))).toBe(
      true,
    )
  })

  it('falls back to the status line a plain http store leaves', () => {
    expect(isUnsatisfiableRange(new Error('416 Range Not Satisfiable'))).toBe(true)
  })

  it('does not swallow a real failure', () => {
    // Anything broader here would turn a missing object or a denied request
    // into a silent empty read, which is the bug this guards against.
    const notFound = Object.assign(new Error('NoSuchKey'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    })
    expect(isUnsatisfiableRange(notFound)).toBe(false)
    expect(isUnsatisfiableRange(new Error('AccessDenied'))).toBe(false)
    expect(isUnsatisfiableRange({ status: 500 })).toBe(false)
    expect(isUnsatisfiableRange(null)).toBe(false)
    expect(isUnsatisfiableRange(undefined)).toBe(false)
  })
})
