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

import type { SandboxPipe } from '../types.ts'

/** The nominal pipe-transport brand (Python's PipeTransportMixin). */
export const PIPE_TRANSPORT: unique symbol = Symbol.for('mirage.pipeTransport')

/**
 * A sandbox that holds a command's stdin and stdout open, byte for byte:
 * what a `mountType` serves the workspace through.
 */
export interface PipeTransport {
  readonly [PIPE_TRANSPORT]: true
  /**
   * Start a command in the sandbox with its stdin and stdout held open,
   * for a `mountType`'s SFTP.
   *
   * @param command the shell command.
   */
  openPipe(command: string): Promise<SandboxPipe>
}

/** Whether this sandbox carries the pipe transport. */
export function isPipeTransport<T extends object>(sandbox: T): sandbox is T & PipeTransport {
  return (sandbox as Partial<PipeTransport>)[PIPE_TRANSPORT] === true
}
