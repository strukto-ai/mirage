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

import type { ByteSource } from '../../../io/types.ts'
import { FileStat, FileType, type PathSpec } from '../../../types.ts'

export async function readStdinAsync(stdin: ByteSource | null): Promise<Uint8Array | null> {
  if (stdin === null) return null
  if (stdin instanceof Uint8Array) return stdin
  const chunks: Uint8Array[] = []
  for await (const chunk of stdin) chunks.push(chunk)
  return concat(chunks)
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function* wrapBytes(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data
}

export function resolveSource(
  stdin: ByteSource | null,
  errorMsg?: string,
): AsyncIterable<Uint8Array> {
  if (stdin === null) {
    if (errorMsg !== undefined) throw new Error(errorMsg)
    // GNU semantics: no stdin behaves like empty input (/dev/null)
    return wrapBytes(new Uint8Array(0))
  }
  if (stdin instanceof Uint8Array) return wrapBytes(stdin)
  return stdin
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

export function isStdin(path: PathSpec): boolean {
  return path.rawPath === '-' || path.virtual === '/dev/stdin'
}

export function stdinStream(
  read: (path: PathSpec) => AsyncIterable<Uint8Array>,
  stdin: ByteSource | null,
): (path: PathSpec) => AsyncIterable<Uint8Array> {
  const source = resolveSource(stdin)[Symbol.asyncIterator]()
  async function* inputStream(): AsyncIterable<Uint8Array> {
    // All '-' operands share one cursor; a new operand must not replay bytes.
    for (;;) {
      const next = await source.next()
      if (next.done === true) return
      yield next.value
    }
  }
  // Bind the backend stream while its mount cache context is active.
  // Byte consumption stays lazy; only stdin needs a shared cursor.
  return (path) => (isStdin(path) ? inputStream() : read(path))
}

export function stdinStat(
  stat: (path: PathSpec) => Promise<FileStat>,
): (path: PathSpec) => Promise<FileStat> {
  return (path) =>
    isStdin(path) ? Promise.resolve(new FileStat({ name: '-', type: FileType.FIFO })) : stat(path)
}
