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
