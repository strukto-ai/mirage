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

// The named argument the `inputs` prelude reads. Spelled so a user
// program can never collide with it by accident.
export const INPUTS_VAR = '__mirage_jq_inputs'

// The named argument the `$ARGS` prelude rebinds.
export const ARGS_VAR = '__mirage_jq_args'

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
  /** --arg / --argjson / --rawfile / --slurpfile bindings, as the values
   * $name resolves to. */
  readonly namedArgs: Readonly<Record<string, unknown>>
  /** --args / --jsonargs values, in order, as $ARGS.positional reports
   * them. */
  readonly positionalArgs: readonly unknown[]
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
  namedArgs: Object.freeze({}),
  positionalArgs: Object.freeze([]),
})

/** A JqOptions built from the fields that differ from the defaults. */
export function jqOptions(overrides: Partial<JqOptions> = {}): JqOptions {
  return Object.freeze({ ...DEFAULT_JQ_OPTIONS, ...overrides })
}
