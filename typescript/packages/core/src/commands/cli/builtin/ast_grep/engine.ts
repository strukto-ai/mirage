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

import { MemoryExhausted } from '../../../../io/errors.ts'
import { UsageError } from '../../../errors.ts'
import { INITIAL, PAGE } from './config.ts'

interface Reply {
  output: string
  updated: string | null
  count: number
  values: string[]
  applied: number
  errors: number
  error?: string
}

async function module(): Promise<WebAssembly.Module> {
  const { default: source } = await import('#mirage-ast-grep-wasm')
  if (typeof source !== 'function') return source
  const load = source as () => WebAssembly.Module
  return load()
}

/** Reuse the bounded guest for successive files in one command. */
export function processor(maxMemory: number) {
  type Exports = WebAssembly.Exports & {
    input(length: number): number
    process(header: number): number
    output(): number
  }
  let guest: { maximum: number; memory: WebAssembly.Memory; exports: Exports } | undefined
  return async function process(
    options: Record<string, string | boolean | null>,
    data: Uint8Array,
    room: number,
  ): Promise<Reply> {
    const header = new TextEncoder().encode(JSON.stringify(options))
    const available = room - header.length * 3 - data.length
    const maximum = Math.floor(Math.min(maxMemory, available) / PAGE)
    if (maximum < INITIAL) throw new MemoryExhausted()
    if (guest === undefined || guest.maximum > maximum) {
      const compiled = await module()
      const memory = new WebAssembly.Memory({ initial: INITIAL, maximum })
      guest = {
        maximum,
        memory,
        exports: new WebAssembly.Instance(compiled, { env: { memory } }).exports as Exports,
      }
    }
    const { exports, memory } = guest
    try {
      const address = exports.input(header.length + data.length)
      const bytes = new Uint8Array(memory.buffer)
      bytes.set(header, address)
      bytes.set(data, address + header.length)
      const size = exports.process(header.length)
      if (size * 4 > available - memory.buffer.byteLength) throw new MemoryExhausted()
      const result = JSON.parse(
        new TextDecoder().decode(new Uint8Array(memory.buffer, exports.output(), size)),
      ) as Reply
      if (result.error !== undefined) throw new UsageError(`ast-grep: ${result.error}`)
      return result
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) {
        guest = undefined
        throw new UsageError('ast-grep: parser resource limit exceeded', 1)
      }
      throw error
    }
  }
}
