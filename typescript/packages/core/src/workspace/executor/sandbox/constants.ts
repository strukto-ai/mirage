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

// Providers whose exec API has no stdin stream (Daytona, e2b) upload
// piped bytes to a per-invocation file and redirect it into the line.
const STDIN_PREFIX = '/tmp/.mirage_stdin'

/**
 * A unique in-sandbox path for one invocation's stdin bytes: unique
 * per invocation so concurrent lines on the same runtime never
 * overwrite each other's payload.
 */
export function stdinPath(): string {
  return `${STDIN_PREFIX}_${crypto.randomUUID().replaceAll('-', '')}`
}

/**
 * The line rewritten to read its stdin from an uploaded file: runs
 * the line in a subshell with stdin redirected from the path, removes
 * the file afterward, and preserves the line's exit code. This is the
 * only byte-exact stdin with a real EOF that Daytona and e2b allow:
 * their exec APIs take no stdin stream, e2b's sendStdin cannot signal
 * EOF, and a PTY merges streams and mangles bytes.
 *
 * Known limitations, all inherent to the file transport:
 * - stdin is fully buffered and uploaded before the line starts;
 *   nothing is streamed, so no interactive stdin.
 * - the bytes briefly touch the sandbox's /tmp, readable by other
 *   processes in the sandbox and left behind if the exec dies before
 *   the `rm` runs (a later line's unique path is never affected).
 * - each stdin line costs two extra provider API calls (mkdir +
 *   upload).
 * - the sandbox must have a POSIX sh (subshell, `$?`, `rm`).
 * If a provider ever adds real exec stdin, drop this for that
 * provider (docker already streams via `docker exec -i`).
 */
export function stdinRedirect(line: string, path: string): string {
  return `( ${line} ) < ${path}; _s=$?; rm -f ${path}; exit $_s`
}
