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
 * The connection to a machine went while a run was on it, and how its
 * program ended went with it; what the run read before is kept. Mirrors
 * Python's ConnectionLostError.
 */
export class ConnectionLostError extends Error {
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array | null

  constructor(
    message: string,
    stdout: Uint8Array = new Uint8Array(),
    stderr: Uint8Array | null = null,
  ) {
    super(message)
    this.name = 'ConnectionLostError'
    this.stdout = stdout
    this.stderr = stderr
  }
}
