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
 * the file afterward, and preserves the line's exit code.
 */
export function stdinRedirect(line: string, path: string): string {
  return `( ${line} ) < ${path}; _s=$?; rm -f ${path}; exit $_s`
}
