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

/** What one shell command line left behind once it finished. */
export interface CommandRun {
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
  readonly status: number
}

/**
 * The entry points an awk program reaches the world through: the main input
 * operands, `getline < file`, output redirection and the command pipes.
 * A failure to open, read or write raises `AwkIOError`.
 */
export interface AwkHost {
  /**
   * Open an input stream by name: a file, or `-` / `/dev/stdin` for
   * stdin. `index` is the ARGV slot the name was read from, so an operand
   * still holding its command-line value reads the file the command line
   * named; null for getline.
   */
  openInput(name: string, index: number | null): AsyncIterable<Uint8Array>
  /** Write output text to a named file, appending or replacing it. */
  writeFile(name: string, body: string, append: boolean): Promise<void>
  /**
   * Run one shell command line to completion, as `sh -c` would take it;
   * a null `stdin` hands it awk's own, still unread.
   */
  run(command: string, stdin: Uint8Array | null): Promise<CommandRun>
}
