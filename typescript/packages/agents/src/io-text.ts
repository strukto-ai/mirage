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

import { describeRefusal, saysWhy } from '@struktoai/mirage-core/policy/index'
import type { Refusal } from '@struktoai/mirage-core/types'
import type { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/workspace'

export function decode(value: Uint8Array | null | undefined): string {
  if (value === null || value === undefined) return ''
  return new TextDecoder('utf-8').decode(value)
}

/**
 * The one line a text surface appends for a refusal, newline included,
 * or the empty string when there is nothing to add: no record, or a text
 * that already says why (an operand-scoped denial's GNU line, wherever
 * it landed). A command-scoped refusal's stderr is bash's bare
 * `Permission denied`, which never does. Mirrors Python's `refusal_line`.
 */
export function refusalLine(text: string, refusal: Refusal | null): string {
  if (refusal === null || saysWhy(text, refusal)) return ''
  return `${describeRefusal(refusal)}\n`
}

/**
 * Append the refusal's reason as one more line after the shell's own
 * output, for a surface that hands the agent text.
 */
export function withRefusal(text: string, refusal: Refusal | null): string {
  const line = refusalLine(text, refusal)
  if (line === '' || text === '') return text || line
  return text.endsWith('\n') ? `${text}${line}` : `${text}\n${line}`
}

export function ioToStr(io: ExecuteResult): string {
  const stdout = io.stdoutText
  const stderr = io.stderrText
  let text = stdout
  if (stderr) text = stdout ? `${stdout}\n${stderr}` : stderr
  return withRefusal(text, io.refusal)
}
