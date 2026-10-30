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

import { IOResult } from '../io/types.ts'
import { byteView, fromByteView } from '../shell/bytes.ts'
import type { StreamRefusal } from './errors.ts'
import { openStreamSync } from './stream.ts'
import type { JsonValue } from '../types.ts'

const decoder = new TextDecoder()

/**
 * A command's typed words, read by mirage-rs before any input is read. The
 * tape holds each option as `[dest, value]` in the order typed, a switch with
 * an empty value. A grammar that reads its operands also gets each operand as
 * `[OPERAND, word]` where it was typed, a glob already expanded into its
 * matches in its place. A value the command refuses never reaches an input.
 * Returns the values keyed as the command's grammar answers; throws
 * StreamRefusal for the first word the command refuses, with the command's
 * exit status. Mirrors Python's `scan`.
 */
export function scan(
  command: string,
  options: readonly (readonly [string, string])[],
): Record<string, JsonValue> {
  const stream = openStreamSync('scan', {
    command,
    options: options.map(([name, text]) => [name, byteView(text)]),
  })
  try {
    return JSON.parse(decoder.decode(stream.finish())) as Record<string, JsonValue>
  } finally {
    stream.close()
  }
}

/** A scan's refusal as the command's result. Mirrors Python's `refused`. */
export function refused(refusal: StreamRefusal): IOResult {
  return new IOResult({
    exitCode: refusal.status,
    stderr: fromByteView(`${refusal.message}\n`),
  })
}
