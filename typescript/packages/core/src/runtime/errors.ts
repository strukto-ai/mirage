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

/** The selected runtime cannot interpret this execution request. */
export class UnsupportedExecutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedExecutionError'
  }
}

/**
 * An evaluation that could not produce a value. The message carries
 * the evaluator's own diagnostics (a traceback, a transport failure,
 * a non-serializable result); `syntax` is true when the program
 * failed to parse, so callers can distinguish "bad script" from
 * "script raised".
 */
export class EvalError extends Error {
  readonly syntax: boolean

  constructor(message: string, options: { syntax?: boolean; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {})
    this.name = 'EvalError'
    this.syntax = options.syntax ?? false
  }
}

/**
 * A rename whose two ends do not live on the same mount.
 *
 * The dispatcher picks the mount from the source and addresses the
 * destination against that same backend, so applying one would drop
 * the source and write the target into the wrong store.
 *
 * The condition is decided once, in RuntimeFiles.rename, and names EXDEV,
 * what rename(2) answers across two file systems; each encoder renders
 * it in its own number for that condition.
 */
export class CrossMountError extends Error {
  readonly src: string
  readonly dst: string
  readonly code = 'EXDEV'

  constructor(src: string, dst: string) {
    super(`cross-mount rename: ${src} -> ${dst}`)
    this.name = 'CrossMountError'
    this.src = src
    this.dst = dst
  }
}
