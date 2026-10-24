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

import type { PathSpec } from '../types.ts'

// Command-line usage error (GNU semantics: stderr message + exit code).
// The message is the full stderr text (may span lines for the
// `Try '--help'` hint). Most tools exit 2 for option errors but 1 for
// operand errors, and the raiser knows which (`usageExitCode` for the
// per-command table). Mirrors Python's mirage.commands.errors.UsageError.
export class UsageError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode = 2) {
    super(message)
    this.exitCode = exitCode
  }
}

// Invalid numeric argument to a find predicate (GNU find: exit 1).
// Mirrors Python's mirage.commands.errors.FindParseError.
export class FindParseError extends Error {}

// A walk past its mount's `walkLimit`. The message is the line the command
// prints where it stopped (`directory` is the operand, or the mount root
// below it); grep and rg throw it to stop reading a directory, keep what
// they printed and exit 2.
// Mirrors Python's mirage.commands.errors.WalkLimitError.
export class WalkLimitError extends Error {
  readonly directory: PathSpec
  constructor(directory: PathSpec, limit: number) {
    super(
      `${directory.rawPath === '' ? '.' : directory.rawPath}: stopped after ${String(limit)} files ` +
        '(walk_limit); narrow the path',
    )
    this.name = 'WalkLimitError'
    this.directory = directory
  }
}

// A command's failure after it had already printed output, which a program
// that writes as it goes leaves on stdout ahead of the diagnostic.
// Mirrors Python's mirage.commands.errors.PartialOutputError.
export class PartialOutputError extends Error {
  readonly stdout: Uint8Array
  constructor(message: string, stdout: Uint8Array) {
    super(message)
    this.name = 'PartialOutputError'
    this.stdout = stdout
  }
}
