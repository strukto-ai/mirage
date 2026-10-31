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
import { UsageError } from '../commands/errors.ts'
import { byteView, fromByteView, textView } from '../shell/bytes.ts'
import { StreamRefusal } from './errors.ts'
import { PARSE_KEPT_CHARS, PARSES_KEPT } from '../commands/spec/constants.ts'
import { openStreamSync } from './stream.ts'
import type { JsonValue } from '../types.ts'

const decoder = new TextDecoder()

// What each command's scan answered, by tape; see `scan`.
export const SCANS = new Map<string, Map<string, string | StreamRefusal>>()

/**
 * A command's typed words, read by mirage-rs before any input is read. The
 * tape holds each option as `[dest, value]` in the order typed, a switch with
 * an empty value. A grammar that reads its operands also gets each operand as
 * `[OPERAND, word]` where it was typed, a glob already expanded into its
 * matches in its place. A value the command refuses never reaches an input.
 * Returns the values keyed as the command's grammar answers; throws
 * StreamRefusal for the first word the command refuses, with the command's
 * exit status.
 *
 * A tape's answer is kept, per command, as a spec keeps its parses
 * (PARSES_KEPT, PARSE_KEPT_CHARS), so the admission gate and the handler
 * reading one line's options share one scan. It is kept as the text
 * mirage-rs answered and decoded per reader, so no reader sees another's
 * changes. Mirrors Python's `scan`.
 */
export function scan(
  command: string,
  options: readonly (readonly [string, string])[],
): Record<string, JsonValue> {
  const tape = JSON.stringify(options)
  let answers: Map<string, string | StreamRefusal> | undefined
  let kept: string | StreamRefusal | undefined
  if (options.reduce((chars, [, text]) => chars + text.length, 0) <= PARSE_KEPT_CHARS) {
    answers = SCANS.get(command)
    if (answers === undefined) {
      answers = new Map()
      SCANS.set(command, answers)
    }
    kept = answers.get(tape)
  }
  if (kept === undefined) {
    try {
      const stream = openStreamSync('scan', {
        command,
        options: options.map(([name, text]) => [name, byteView(text)]),
      })
      try {
        kept = decoder.decode(stream.finish())
      } finally {
        stream.close()
      }
    } catch (err) {
      if (!(err instanceof StreamRefusal)) throw err
      kept = err
    }
    if (answers !== undefined) {
      if (answers.size >= PARSES_KEPT) answers.clear()
      answers.set(tape, kept)
    }
  }
  if (kept instanceof StreamRefusal) throw new StreamRefusal(kept.message, kept.output, kept.status)
  return JSON.parse(kept) as Record<string, JsonValue>
}

/**
 * `scan` for a command whose refusals travel as usage errors: throws
 * UsageError for the first value the command refuses, in its words and with
 * its exit status. Mirrors Python's `scanned`.
 */
export function scanned(
  command: string,
  options: readonly (readonly [string, string])[],
): Record<string, JsonValue> {
  try {
    return scan(command, options)
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    throw new UsageError(textView(err.message), err.status)
  }
}

/** A scan's refusal as the command's result. Mirrors Python's `refused`. */
export function refused(refusal: StreamRefusal): IOResult {
  return new IOResult({
    exitCode: refusal.status,
    stderr: fromByteView(`${refusal.message}\n`),
  })
}
