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

export const DEFAULT_INDENT = 2

// What jq names standard input when it reports where it stands, and what
// it reports before it has read any input at all.
export const STDIN_NAME = '<stdin>'
export const UNKNOWN_POSITION = '<unknown>'

/**
 * jq's `jv_invalid()` where a value could stand: nothing yet, which is not
 * the same as null.
 */
export const NO_VALUE: unique symbol = Symbol('no-value')
export type NoValue = typeof NO_VALUE

/**
 * jq's parser refusing its input: the message, with the line and the column
 * it had reached, as jq's report words it (e.g. `Unfinished JSON term at EOF
 * at line 1, column 3`). A class, so no parsed JSON value can pass for one.
 */
export class JqParseError {
  constructor(readonly message: string) {}
}

/**
 * One input of the stream jq reads: a file operand or stdin. `name` is the
 * input as jq reports it, the operand as the command line spelled it or
 * `<stdin>`.
 */
export interface InputSource {
  readonly name: string
  readonly chunks: AsyncIterable<Uint8Array>
}

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

/** Which of the builtins that read the input stream a program calls. */
export interface StreamReads {
  /** `input`, which takes the next unread document. */
  readonly input: boolean
  /** `inputs`, which yields every unread document. */
  readonly inputs: boolean
}

// The record separator an application/json-seq stream puts before every
// value (RFC 7464).
export const RS = '\u001e'

/**
 * One jq invocation's resolved options.
 *
 * The command line's implications are already applied by the caller
 * (`-j` and `--raw-output0` imply `-r`, `--tab` and `--indent` resolve
 * into one indent width), so every consumer reads plain fields. Mirrors
 * Python's JqOptions.
 */
export interface JqOptions {
  /** -n, run the program once against null and never read the inputs as
   * the program's input. */
  readonly nullInput: boolean
  /** -R, each input line is a string instead of a JSON document. */
  readonly rawInput: boolean
  /** -s, collapse the whole input stream into one value (an array of
   * documents, or one string under -R). */
  readonly slurp: boolean
  /** --stream, replace each input document with its [path, leaf] events,
   * the same ones `tostream` emits. */
  readonly stream: boolean
  /** --seq, read and write RFC 7464 JSON text sequences (every value
   * preceded by RS). */
  readonly seq: boolean
  /** -r, print a string output unquoted. */
  readonly rawOutput: boolean
  /** -j, write no separator after an output. */
  readonly joinOutput: boolean
  /** --raw-output0, write a NUL after an output. */
  readonly nulOutput: boolean
  /** -c, one line of JSON per output. */
  readonly compact: boolean
  /** -a, escape every non-ASCII character. jq prints strings quoted
   * under -a even with -r. */
  readonly asciiOutput: boolean
  /** -S, sort object keys. */
  readonly sortKeys: boolean
  /** Indent with one tab per level. */
  readonly tab: boolean
  /** Spaces per indent level when not compact. */
  readonly indent: number
  /** -e, derive the exit code from the last output value. */
  readonly exitStatus: boolean
  /** --arg / --argjson / --rawfile / --slurpfile bindings, each the JSON
   * text of the value $name resolves to, in the order they were bound. */
  readonly namedArgs: ReadonlyMap<string, string>
  /** --args / --jsonargs values, in order, as JSON text of what
   * $ARGS.positional reports. */
  readonly positionalArgs: readonly string[]
}

const DEFAULT_JQ_OPTIONS: JqOptions = Object.freeze({
  nullInput: false,
  rawInput: false,
  slurp: false,
  stream: false,
  seq: false,
  rawOutput: false,
  joinOutput: false,
  nulOutput: false,
  compact: false,
  asciiOutput: false,
  sortKeys: false,
  tab: false,
  indent: DEFAULT_INDENT,
  exitStatus: false,
  namedArgs: new Map<string, string>(),
  positionalArgs: Object.freeze([]),
})

/** A JqOptions built from the fields that differ from the defaults. */
export function jqOptions(overrides: Partial<JqOptions> = {}): JqOptions {
  return Object.freeze({ ...DEFAULT_JQ_OPTIONS, ...overrides })
}
