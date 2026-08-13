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

import type { IOResult, OpReport } from '../io/types.ts'
import type { PathSpec } from '../types.ts'
import type { RuntimeConfig } from './config.ts'
import type { PolicyScript } from './policy/types.ts'

/**
 * The languages a runtime can interpret, one name for both doors (run
 * and eval). A union, not string, so a typo is a type error instead of
 * a selector that silently matches nothing and reports "no runtime".
 */
export type RuntimeLanguage = 'python' | 'js'

/**
 * The workspace op dispatch: run `op` against the mount owning `path`
 * and return its result with the accounting IOResult. Defined here, on
 * the consumer side, because runtimes receive it (attach) while the
 * workspace provides it, and the runtime package imports no workspace
 * module — the home of Python's DispatchFn protocol (runtime/types).
 * `report`, when a caller passes one, is stamped by the door the moment
 * the op completes, so an observer reads what ran even when a later
 * step throws the result away; runtimes and combiners never pass it.
 */
export type DispatchFn = (
  op: string,
  path: PathSpec,
  args?: readonly unknown[],
  kwargs?: Record<string, unknown>,
  report?: OpReport,
) => Promise<[unknown, IOResult]>

/**
 * The narrow bridge a sandboxed guest's file I/O rides: fixed op names,
 * string paths, positional payloads (the guest cannot build PathSpecs).
 */
export type BridgeDispatchFn = (
  op:
    | 'read'
    | 'write'
    | 'append'
    | 'readdir'
    | 'stat'
    | 'create'
    | 'truncate'
    | 'unlink'
    | 'mkdir'
    | 'rmdir'
    | 'rename',
  path: string,
  bytes?: Uint8Array,
  dst?: string,
) => Promise<unknown>

/**
 * Live view of the workspace mount prefixes, read per run so mounts
 * added or removed after construction are always picked up.
 */
export type PrefixSource = () => string[]

/** One interpreter execution request, language-agnostic. */
export interface RunArgs {
  code: string
  args: string[]
  /**
   * The program's own name, for the argv slot a program reads to prefix
   * its messages. Set by the CLI script tier (the installed head word,
   * so a renamed install names itself), absent for the interpreter
   * commands, which keep their engine's own spelling. A runtime that
   * assembles argv itself fills slot 0 with it; where a real
   * interpreter defines that slot (CPython under `-c`) it cannot apply.
   */
  prog?: string
  env: Record<string, string>
  stdin: Uint8Array | null
  /**
   * Interpreter-level switches parsed by the command's spec (e.g. js
   * module mode). Each runtime reads its own switches and ignores the
   * rest.
   */
  flags?: Record<string, unknown>
  /**
   * Aborted when the command's limit timeout trips, so a runtime
   * holding external resources (the local subprocess) can reclaim
   * them. Python needs no equivalent: asyncio cancels the run task
   * and the runtime cleans up in its CancelledError handler.
   */
  signal?: AbortSignal
  /**
   * The limit timeout, for engines that execute on the event loop
   * (quickjs) and must interrupt themselves in-VM: a guest that blocks
   * the loop also blocks the timer that would abort `signal`.
   */
  timeoutSeconds?: number
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
export interface RuntimeOptions<C extends RuntimeConfig = Record<string, unknown>> {
  /**
   * Commands this runtime claims, overriding the class default; ["*"]
   * claims every line for a line-executing runtime.
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
   * want this line": a function taking a PolicyContext, or a
   * config-borne ScriptSource. Absent = always willing. Policy, not
   * capability: it can only refuse lines the captures already allow.
   */
  script?: PolicyScript
}
