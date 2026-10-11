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

/** Raised when the daemon's SSH settings are unusable. */
export class SSHConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SSHConfigError'
  }
}

/** A codex-exec request answered with a JSON-RPC error. */
export class CodexRPCError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = 'CodexRPCError'
    this.code = code
  }
}
