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

import { PolicyDenied, describeDecision } from '../../policy/index.ts'
import type { PolicyDecision } from '../../types.ts'
import type { ExecuteResult } from '../workspace/types.ts'
import { errorVirtualPath, fsStrerror } from '../../errors/fs.ts'

export function decode(value: Uint8Array | null | undefined): string {
  if (value === null || value === undefined) return ''
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(value)
}

/**
 * The one line a text surface appends for a refusal, newline included, or
 * the empty string when there is no record. The refusal's stderr is the
 * bare `Permission denied` or the path's own error, which never says why.
 * Mirrors Python's `decision_line`.
 */
export function decisionLine(decision: PolicyDecision | null): string {
  if (decision === null) return ''
  return `${describeDecision(decision)}\n`
}

/**
 * Append the refusal's reason as one more line after the shell's own
 * output, for a surface that hands the agent text.
 */
export function withDecision(text: string, decision: PolicyDecision | null): string {
  const line = decisionLine(decision)
  if (line === '' || text === '') return text || line
  return text.endsWith('\n') ? `${text}${line}` : `${text}\n${line}`
}

/**
 * A tool's failure as the agent reads it: a filesystem error as
 * `<path>: <phrase>` (a policy's refusal reads as `Permission denied`),
 * or the phrase alone when no path was stamped and the message adds
 * nothing, anything else in its own words, then the refusal's line when a
 * policy refused the op. Mirrors Python's `error_text`.
 */
export function errorText(error: unknown): string {
  const strerror = fsStrerror(error)
  const message = error instanceof Error ? error.message : String(error)
  const stamped =
    strerror !== null && typeof (error as { virtualPath?: unknown }).virtualPath === 'string'
  const words =
    strerror === null
      ? message
      : stamped
        ? `${errorVirtualPath(error)}: ${strerror}`
        : message === '' || message === strerror
          ? strerror
          : `${message}: ${strerror}`
  return withDecision(`Error: ${words}`, error instanceof PolicyDenied ? error.decision : null)
}

export function ioToStr(io: ExecuteResult): string {
  const stdout = io.stdoutText
  const stderr = io.stderrText
  let text = stdout
  if (stderr) text = stdout ? `${stdout}\n${stderr}` : stderr
  return withDecision(text, io.decision)
}

/**
 * The edit tools' one substitution: `content` with `oldString` replaced
 * once, or everywhere under `replaceAll`, beside how many times it occurs.
 * The replacement is literal (no `$&` or `$1` expansion), as Python's
 * `str.replace` is; a count other than one without `replaceAll` is the
 * caller's refusal to word. Mirrors Python's `replace_text`.
 */
export function replaceText(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): [string, number] {
  const parts = content.split(oldString)
  const text = replaceAll ? parts.join(newString) : content.replace(oldString, () => newString)
  return [text, parts.length - 1]
}
