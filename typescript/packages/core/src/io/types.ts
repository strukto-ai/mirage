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

import { CachableAsyncIterator } from './cachable_iterator.ts'

export type ByteSource = Uint8Array | AsyncIterable<Uint8Array>

export async function materialize(source: ByteSource | null | undefined): Promise<Uint8Array> {
  if (source === null || source === undefined) return new Uint8Array()
  if (source instanceof Uint8Array) return source
  if (source instanceof CachableAsyncIterator) return source.drain()
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  return concat(chunks)
}

export interface IOResultInit {
  stdout?: ByteSource | null
  stderr?: ByteSource | null
  exitCode?: number
  reads?: Record<string, ByteSource>
  writes?: Record<string, ByteSource>
  cache?: string[]
}

export class IOResult {
  stdout: ByteSource | null
  stderr: ByteSource | null
  private _exitCode: number
  reads: Record<string, ByteSource>
  writes: Record<string, ByteSource>
  cache: string[]
  streamSource: IOResult | null

  constructor(init: IOResultInit = {}) {
    this.stdout = init.stdout ?? null
    this.stderr = init.stderr ?? null
    this._exitCode = init.exitCode ?? 0
    this.reads = init.reads ?? {}
    this.writes = init.writes ?? {}
    this.cache = init.cache ?? []
    this.streamSource = null
  }

  get exitCode(): number {
    return this._exitCode
  }

  // An explicit write to exitCode wins over any lazy streamSource mirror.
  // Without this, fanOutTraversal's aggregated exit code gets clobbered by
  // syncExitCode() following streamSource from the last merged sub-IO.
  set exitCode(v: number) {
    this._exitCode = v
    this.streamSource = null
  }

  async materializeStdout(): Promise<Uint8Array> {
    const bytes = await materialize(this.stdout)
    this.stdout = bytes
    return bytes
  }

  async stdoutStr(errors: 'replace' | 'strict' = 'replace'): Promise<string> {
    return decodeBytes(await this.materializeStdout(), errors)
  }

  async materializeStderr(): Promise<Uint8Array> {
    const bytes = await materialize(this.stderr)
    this.stderr = bytes
    return bytes
  }

  async stderrStr(errors: 'replace' | 'strict' = 'replace'): Promise<string> {
    return decodeBytes(await this.materializeStderr(), errors)
  }

  syncExitCode(): void {
    if (this.streamSource !== null) {
      this.streamSource.syncExitCode()
      this.exitCode = this.streamSource.exitCode
    }
  }

  async merge(other: IOResult): Promise<IOResult> {
    const leftStderr = await materialize(this.stderr)
    const rightStderr = await materialize(other.stderr)
    let mergedStderr: Uint8Array | null = null
    if (leftStderr.byteLength > 0 || rightStderr.byteLength > 0) {
      mergedStderr = concat([leftStderr, rightStderr])
    }
    other.syncExitCode()
    const result = new IOResult({
      stdout: other.stdout,
      stderr: mergedStderr,
      exitCode: other.exitCode,
      reads: { ...this.reads, ...other.reads },
      writes: { ...this.writes, ...other.writes },
      cache: [...this.cache, ...other.cache],
    })
    result.streamSource = other
    return result
  }

  async mergeAggregate(other: IOResult): Promise<IOResult> {
    const result = await this.merge(other)
    result.exitCode = Math.max(this.exitCode, other.exitCode)
    return result
  }
}

function decodeBytes(bytes: Uint8Array, errors: 'replace' | 'strict'): string {
  return new TextDecoder('utf-8', { fatal: errors === 'strict' }).decode(bytes)
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}
