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

// A bash arithmetic syntax or evaluation error. Mirrors Python's
// mirage.shell.errors.ArithError.
export class ArithError extends Error {}

// A fatal shell exit request unwinding the current execution. Raised by
// the `exit` builtin and by fatal expansion errors (`${var:?msg}`), which
// bash treats as an implicit `exit 1` in a non-interactive shell.
// Contained at subshell, pipeline-segment, and background-job boundaries;
// the top-level program loop stops the remaining statements. Mirrors
// Python's mirage.shell.errors.ExitSignal.
export class ExitSignal extends Error {
  readonly exitCode: number
  stderr: Uint8Array
  stdout: Uint8Array | null
  // Status a containing boundary reports instead of exitCode. GNU bash
  // exits 127 on a fatal expansion error but a subshell wrapping one
  // returns 1; `exit N` uses N in both positions (the default).
  readonly containedCode: number

  constructor(
    exitCode = 0,
    stderr: Uint8Array = new Uint8Array(),
    stdout: Uint8Array | null = null,
    containedCode: number | null = null,
  ) {
    super('exit')
    this.name = 'ExitSignal'
    this.exitCode = exitCode
    this.stderr = stderr
    this.stdout = stdout
    this.containedCode = containedCode ?? exitCode
  }
}
