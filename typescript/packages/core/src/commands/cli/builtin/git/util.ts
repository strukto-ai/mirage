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

import type { CommandFnResult } from '../../../config.ts'
import type { FlagView } from '../../../spec/types.ts'
import { IOResult } from '../../../../io/types.ts'
import type { GitError } from './errors.ts'
import { UnrecognizedArgumentError } from './errors.ts'

const ROOT = '/'
const HEAD = 'HEAD'

const ENC = new TextEncoder()

/**
 * Where repository discovery begins for this invocation.
 *
 * `-C` changes directory before anything else happens, git's own reading of the
 * option. It needs no separate session-cwd fact: the option is declared with a
 * `'.'` default, and a PATH default lands as if typed, so an absent `-C`
 * resolves to the session cwd and a relative `-C build` is already absolute by
 * the time it arrives.
 *
 * Read as a string, not a PathSpec: group-level values are resolved by the walk
 * and reach a leaf as absolute virtual paths, while a leaf's own PATH flags are
 * recovered as PathSpec by parseFlags.
 *
 * @param fl spec-validated view over the leaf's flag bag
 */
export function startPoint(fl: FlagView): string {
  return fl.asStr('C') ?? ROOT
}

/**
 * The revision operand a verb was given, or git's own default.
 *
 * @param texts positional text operands
 * @param fallback what an absent operand means
 */
export function revisionArg(texts: readonly string[], fallback: string = HEAD): string {
  return texts[0] ?? fallback
}

/**
 * Refuse an operand that is really an option this build lacks.
 *
 * A verb taking a revision accepts free text, so every flag mirage does not
 * declare reaches it as one. Resolving it as a revision is the wrong answer
 * twice over: it fails, and it fails saying the repository has no such commit,
 * when what happened is that mirage has no such flag. Refused here, before any
 * object is read, so the message names the real problem.
 *
 * A pathspec is not checked for and cannot be: the shared parser consumes `--`
 * as its end-of-options marker, so `log -- a.txt` and `log a.txt` reach a leaf
 * identically. Both resolve the operand as a revision and fail with git's own
 * "unknown revision or path" wording, which is exactly right for an untracked
 * path and a deliberate divergence for a tracked one, where git would narrow the
 * walk instead. Erring is the safe half of that trade: limiting by nothing would
 * print every commit and look like an answer.
 *
 * Which refusal to raise is the caller's, because git words this differently per
 * verb and means each one: see UnknownSwitchError for the three.
 *
 * @param texts positional text operands, as typed
 * @param error the refusal this verb words it with
 */
export function checkOperands(
  texts: readonly string[],
  error: new (argument: string) => GitError = UnrecognizedArgumentError,
): void {
  for (const text of texts) {
    if (text.startsWith('-')) throw new error(text)
  }
}

/**
 * Render a git error: `<prefix>: <message>`, on its own stream.
 *
 * git uses 128 for a fatal, which is neither the dispatcher's usage exit (2) nor
 * its generic handler-error exit (1), so leaves return the code rather than
 * throwing into the catch-all. A refused option carries its own prefix and code
 * instead, which is git's own split, and a refusal that is really a report
 * ("nothing to commit") carries no prefix and goes to stdout.
 *
 * @param exc the error to render
 */
export function fatal(exc: GitError): CommandFnResult {
  const body = exc.prefix === null ? `${exc.message}\n` : `${exc.prefix}: ${exc.message}\n`
  const data = ENC.encode(body)
  if (exc.stream === 'stdout') return [data, new IOResult({ exitCode: exc.code })]
  return [null, new IOResult({ exitCode: exc.code, stderr: data })]
}
