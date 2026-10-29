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

import { fsStrerror, isEisdir } from '../../errors/fs.ts'

/**
 * jq's refusal of a program, which jq reports on stderr and exits 3
 * for. The message is jq's report, numbered by the program's own lines.
 */
export class JqCompileError extends Error {}

/**
 * Why jq could not load a whole file (jv_load_file): an -f program, a
 * --rawfile or a --slurpfile, named as typed. It opens the file itself, so a
 * directory gets words of its own instead of a failed read.
 */
export function loadFailure(name: string, err: unknown): string {
  if (isEisdir(err)) return `Could not open ${name}: It's a directory`
  return `Could not open ${name}: ${fsStrerror(err) ?? ''}`
}
