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

import type { RouteScript } from './route/types.ts'

/** One interpreter execution request, language-agnostic. */
export interface RunArgs {
  code: string
  args: string[]
  env: Record<string, string>
  stdin: Uint8Array | null
  /**
   * Interpreter-level switches parsed by the command's spec (e.g. js
   * module mode). Each runtime reads its own switches and ignores the
   * rest.
   */
  flags?: Record<string, unknown>
}

/** Outcome of one interpreter execution. */
export interface RunResult {
  stdout: Uint8Array
  /** Captured standard error, null when empty (mirrors Python). */
  stderr: Uint8Array | null
  exitCode: number
}

/**
 * The value contract of eval: never richer than JSON plus bytes, so
 * any evaluator (in-process or remote over a serialized transport)
 * can carry it, in either direction (inputs in, verdict out).
 */
export type EvalValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | EvalValue[]
  | { [key: string]: EvalValue }

/**
 * "incomplete" is console semantics: the source needs a continuation
 * line (session mode only). "exit" is an explicit exit() call.
 */
export type EvalStatus = 'complete' | 'incomplete' | 'exit'

/**
 * Outcome of one evaluation (mirrors Python's EvalResult).
 *
 * One-shot mode rejects with EvalError on any failure, so a returned
 * result is always a success. Session (console) mode is a transcript:
 * a failing snippet comes back as a result too (its traceback on
 * stderr, a nonzero exitCode), because a console reports errors and
 * keeps going.
 */
export interface EvalResult {
  /**
   * The program's last expression. In-process evaluators return it
   * directly; remote ones return what the transport could carry.
   * Session (console) mode may report null when the evaluator only
   * streams output.
   */
  value: EvalValue
  /** Output the program printed while running. */
  stdout: Uint8Array
  /** Captured standard error, null when empty. */
  stderr: Uint8Array | null
  /** 0 outside session mode; a console snippet's exit. */
  exitCode: number
  /** Console verdict; always "complete" outside session mode. */
  status: EvalStatus
}

/** Constructor options every runtime accepts (a yaml entry's keys). */
export interface RuntimeOptions<C extends object = Record<string, unknown>> {
  /**
   * Commands this runtime claims, overriding the class default; ["*"]
   * claims every line for a runsLines runtime.
   */
  captures?: readonly string[]
  /**
   * The runtime's implementation knobs (a yaml entry's `config`
   * block), coerced against the runtime's own key list so a field the
   * runtime does not have fails loud.
   */
  config?: C
  /**
   * Per-line admission script for the routing ladder, answering "do I
   * want this line": a function taking a RouteContext, or a
   * config-borne ScriptSource. Absent = always willing. Policy, not
   * capability: it can only refuse lines the captures already allow.
   */
  script?: RouteScript
}
