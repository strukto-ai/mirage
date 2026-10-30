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

// What jq names standard input when it reports where it stands, and what
// it reports before it has read any input at all.
export const STDIN_NAME = '<stdin>'

/**
 * An error no `try` caught, which ends one run: jq reports it and goes on
 * with the next document.
 */
export interface JqError {
  readonly kind: 'error'
  /** The message as jq prints it: a string as it is, anything else in
   * jq's own compact dump. */
  readonly text: string
  /** Whether the message was a string, which jq's report says when it
   * was not. */
  readonly string: boolean
  /** Whether the program raised it with `error` itself, which jq never
   * tells apart but gojq does. */
  readonly own?: boolean
}

/** `halt` or `halt_error`, which end the whole invocation. */
export interface JqHalt {
  readonly kind: 'halt'
  /** halt_error's input as jq prints it (a string as it is, anything else
   * in jq's compact dump), or null for `halt` and for a null input, which
   * print nothing. */
  readonly message: string | null
  /** Whether that input was a string, which jq prints with no newline of
   * its own. */
  readonly string: boolean
  /** The exit code `halt_error` named, or null for `halt`. */
  readonly code: number | null
}

/** What one run of a program printed, and what ended it early. */
export interface JqRun<T = unknown> {
  /** Every output it printed, in order: a value, or jq's own compact dump
   * of one. */
  readonly outputs: T[]
  /** The error or the halt that ended it, or null when it ran to its end. */
  readonly stop: JqError | JqHalt | null
}
