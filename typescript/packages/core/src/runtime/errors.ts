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
 * Deliberately carries no errno. The condition is decided once, in
 * RuntimeVFS.rename, and each encoder maps it to the number its own
 * reference implementation answers: pathlib says EXDEV, while a WASI
 * guest sees ENOENT because each mount is its own preopen. Unifying
 * those two is a separate decision from writing the rule down once.
 */
export class CrossMountError extends Error {
  readonly src: string
  readonly dst: string
  // The condition's own seat, not EXDEV: each boundary's table decides
  // the number (posix says EXDEV, the WASI wire deliberately ENOENT).
  readonly code = 'CROSS_MOUNT'

  constructor(src: string, dst: string) {
    super(`cross-mount rename: ${src} -> ${dst}`)
    this.name = 'CrossMountError'
    this.src = src
    this.dst = dst
  }
}
