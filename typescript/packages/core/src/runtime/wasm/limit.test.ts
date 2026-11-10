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
import { capMemory, startRefusal } from './limit.ts'

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
const EXPORT = [0x07, 0x0a, 0x01, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00]
const OPEN_MEMORY = [0x05, 0x03, 0x01, 0x00, 0x01]

function memoryOf(bytes: Uint8Array): WebAssembly.Memory {
  const module = new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>)
  return new WebAssembly.Instance(module).exports.memory as WebAssembly.Memory
}

describe('capMemory', () => {
  const open = new Uint8Array([...HEADER, ...OPEN_MEMORY, ...EXPORT])

  it('holds a memory with no maximum to the pages asked for', () => {
    const memory = memoryOf(capMemory(open, 3))
    expect(memory.grow(2)).toBe(1)
    expect(() => memory.grow(1)).toThrow(RangeError)
  })

  it('replaces a maximum the module named', () => {
    const named = new Uint8Array([...HEADER, 0x05, 0x04, 0x01, 0x01, 0x01, 0x7f, ...EXPORT])
    const memory = memoryOf(capMemory(named, 2))
    expect(memory.grow(1)).toBe(1)
    expect(() => memory.grow(1)).toThrow(RangeError)
  })

  it('keeps a tighter maximum the module named', () => {
    const named = new Uint8Array([...HEADER, 0x05, 0x04, 0x01, 0x01, 0x01, 0x03, ...EXPORT])
    const memory = memoryOf(capMemory(named, 300))
    expect(memory.grow(2)).toBe(1)
    expect(() => memory.grow(1)).toThrow(RangeError)
  })

  it('holds a limit past 4 GiB to what a 32-bit memory can name', () => {
    expect(() => memoryOf(capMemory(open, 8 * 16384))).not.toThrow()
  })

  it('lets a module start on its own minimum whatever the limit', () => {
    const memory = memoryOf(capMemory(open, 0))
    expect(memory.buffer.byteLength).toBe(65536)
    expect(() => memory.grow(1)).toThrow(RangeError)
  })

  it('reads a size past one byte', () => {
    const memory = memoryOf(capMemory(open, 300))
    expect(memory.grow(299)).toBe(1)
    expect(() => memory.grow(1)).toThrow(RangeError)
  })

  it('leaves a module with no memory alone', () => {
    const empty = new Uint8Array(HEADER)
    expect(capMemory(empty, 3)).toBe(empty)
  })
})

describe('startRefusal', () => {
  const two = new Uint8Array([...HEADER, 0x05, 0x03, 0x01, 0x00, 0x02, ...EXPORT])

  it('refuses a limit below the pages the memory starts on', () => {
    expect(startRefusal(two, 2 * 65536 - 1)).toBe(
      'memory minimum size of 2 pages exceeds memory limits',
    )
  })

  it('lets a module start on exactly its pages', () => {
    expect(startRefusal(two, 2 * 65536)).toBeNull()
  })

  it('lets a module with no memory start within nothing', () => {
    expect(startRefusal(new Uint8Array(HEADER), 0)).toBeNull()
  })
})
