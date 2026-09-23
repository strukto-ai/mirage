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

import type { ByteSource } from '../../../../io/types.ts'
import { fsStrerror } from '../../../../utils/errors.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { handleBash } from './bash.ts'
import { readScriptText, scriptError } from './script.ts'
import type { ExecuteStringFn, Result } from '../types.ts'

/** The interpreter words a script's first line names, env resolved. */
/**
 * Consume env's -S/--split-string option on a shebang line.
 *
 * GNU env documents -S as the facility for passing an interpreter plus
 * options through a shebang (the kernel hands env everything after it
 * as one argument, and -S re-splits it), so the option is spelling, not
 * a word: `-S bash -x`, `-Sbash -x` and `--split-string=bash -x` all
 * name bash. The line is already whitespace-split here, so consuming
 * the option is all that is left.
 */
function envSplitString(words: string[]): string[] {
  const first = words[0]
  if (first === undefined) return words
  if (first === '-S' || first === '--split-string') return words.slice(1)
  let head: string
  if (first.startsWith('--split-string=')) {
    head = first.slice('--split-string='.length)
  } else if (first.startsWith('-S')) {
    head = first.slice(2)
  } else {
    return words
  }
  return head === '' ? words.slice(1) : [head, ...words.slice(1)]
}

function shebangWords(script: string): string[] {
  const first = script.split('\n', 1)[0] ?? ''
  if (!first.startsWith('#!')) return []
  let words = first
    .slice(2)
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '')
  const head = words[0] ?? ''
  if (head.slice(head.lastIndexOf('/') + 1) === 'env') {
    words = envSplitString(words.slice(1))
  }
  const lead = words[0]
  if (lead !== undefined) {
    words[0] = lead.slice(lead.lastIndexOf('/') + 1)
  }
  return words
}

/** Quote one word for re-dispatch as a shell line. */
function quoteWord(word: string): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(word)) return word
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/**
 * Run a slash-carrying head word as a program, bash's loader rule.
 *
 * bash hands a word containing a slash straight to the loader: no
 * builtin, function, or install can claim it, and the file either runs
 * or the shell reports why not. Two deliberate divergences from bash,
 * both consequences of the VFS: there is no exec bit to check (`chmod`
 * is stored, not enforced; mount mode does real access control), so an
 * existing file runs without `+x`; and the shell prefix bash puts on
 * the diagnostic is dropped, matching every other mirage diagnostic.
 *
 * A shebang naming sh or bash (directly or via env) runs through the
 * nested-shell machinery, as does a script with none. Any other
 * interpreter word is re-dispatched as a command line, so
 * `#!/usr/bin/env python3` reaches the python3 command wherever the
 * workspace routes it, and an interpreter nobody registers answers with
 * its own "command not found".
 */
export async function handleExecPath(
  dispatch: DispatchFn,
  executeFn: ExecuteStringFn,
  path: string,
  args: string[],
  session: SessionState,
  stdin: ByteSource | null = null,
): Promise<Result> {
  let script: string
  try {
    script = await readScriptText(dispatch, path, session.cwd)
  } catch (exc) {
    const strerror = fsStrerror(exc)
    if (strerror === null) throw exc
    const code = (exc as { code?: string }).code
    return scriptError(path, strerror, code === 'ENOENT' ? 127 : 126)
  }
  const words = shebangWords(script)
  const interp = words[0] ?? 'sh'
  if (interp === 'sh' || interp === 'bash') {
    return handleBash(
      dispatch,
      executeFn,
      [...words.slice(1), path, ...args],
      session,
      stdin,
      interp,
    )
  }
  const line = [...words, path, ...args].map(quoteWord).join(' ')
  const io = await executeFn(line, { sessionId: session.sessionId, stdin })
  const label = args.length > 0 ? `${path} ${args.join(' ')}` : path
  return [io.stdout, io, new ExecutionNode({ command: label, exitCode: io.exitCode })]
}
