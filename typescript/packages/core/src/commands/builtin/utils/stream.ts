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
import { concat } from '../../../utils/bytes.ts'

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

export function resolveSource(stdin: ByteSource | null): AsyncIterable<Uint8Array> {
  if (stdin === null) {
    // GNU semantics: no stdin behaves like empty input (/dev/null)
    return wrapBytes(new Uint8Array(0))
  }
  if (stdin instanceof Uint8Array) return wrapBytes(stdin)
  return stdin
}

/**
 * Whether an operand reads stdin. `dash` says a literal `-` names stdin, as
 * it does for most GNU tools; util-linux `rev` and binutils `strings` open it
 * as a file, so only /dev/stdin is stdin to them.
 */
export function isStdin(path: PathSpec, dash = true): boolean {
  return (dash && path.rawPath === '-') || path.virtual === '/dev/stdin'
}

/**
 * The name a command's output gives an operand. Only a literal `-` is stdin by
 * name: /dev/stdin reads the same bytes, but GNU grep, head and tail name it as
 * the path it is.
 */
export function operandLabel(path: PathSpec, stdinName: string): string {
  return path.rawPath === '-' ? stdinName : path.rawPath
}

/**
 * Read each operand from its backend, or from stdin for a stdin one.
 *
 * Every stdin operand shares one cursor, so a later `-` never replays bytes
 * an earlier one read, and the cursor never closes the input a later one may
 * still read. `sole` says stdin has exactly one reader, which takes the input
 * itself, so a scan that stops early closes it. `dash` is as in `isStdin`.
 */
export function stdinStream(
  read: (path: PathSpec) => AsyncIterable<Uint8Array>,
  stdin: ByteSource | null,
  sole = false,
  dash = true,
): (path: PathSpec) => AsyncIterable<Uint8Array> {
  const input = resolveSource(stdin)
  const source = input[Symbol.asyncIterator]()
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
  return (path) => {
    if (!isStdin(path, dash)) return read(path)
    return sole ? input : inputStream()
  }
}

/** Stat each operand on its backend, or as a stream for a stdin one. */
export function stdinStat(
  stat: (path: PathSpec) => Promise<FileStat>,
  dash = true,
): (path: PathSpec) => Promise<FileStat> {
  return (path) =>
    isStdin(path, dash)
      ? Promise.resolve(new FileStat({ name: '-', type: FileType.FIFO }))
      : stat(path)
}
