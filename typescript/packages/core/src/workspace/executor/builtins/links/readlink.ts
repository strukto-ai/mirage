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

import { canonicalize } from '../../../../commands/builtin/generic/realpath.ts'
import { missingOperandError } from '../../../../commands/spec/usage.ts'
import { dispatchStat, dotRefusal } from '../../../../commands/builtin/utils/paths.ts'
import { posixPhrase } from '../../../../errors/posix.ts'
import { PathSpec } from '../../../../types.ts'
import { PolicyDenied } from '../../../../policy/index.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { fsErrorLine } from '../../../../errors/render.ts'
import { fsStrerror, walkRefusal } from '../../../../errors/fs.ts'
import type { Namespace } from '../../../mount/namespace/namespace.ts'
import type { SessionState } from '../../../session/session.ts'
import { fail, operandText, parseLine, result } from '../shared.ts'
import { operandAbs } from './ln.ts'
import type { Result } from '../types.ts'
import { encodeText } from '../../../../shell/bytes.ts'

// Any filesystem answer other than a target: a refusal (session view or
// policy), EINVAL (not a link), ENOENT (absent, which is what a hidden
// path answers). All of them land on GNU readlink's silent exit 1, so
// this matches python's `except OSError` rather than naming errnos one
// at a time — a list would silently print a raw path the first time a
// dispatcher answered with an errno nobody had added yet.
function readlinkRefused(err: unknown): boolean {
  if (err instanceof PolicyDenied) return true
  return typeof (err as { code?: unknown }).code === 'string'
}

// The last canonicalizing flag decides how much of the path must exist, in
// the mode letters canonicalize takes ('' is -f). Mirrors Python's
// CANONICAL_MODES.
const CANONICAL_MODES: Readonly<Record<string, string>> = {
  canonicalize: '',
  canonicalize_existing: 'e',
  canonicalize_missing: 'm',
}

// readlink's operands as received: every word that is not an option, the
// words after `--` included. None of its options takes a value. Mirrors
// Python's operand_words.
export function operandWords(args: readonly (string | PathSpec)[]): (string | PathSpec)[] {
  const words: (string | PathSpec)[] = []
  let options = true
  for (const arg of args) {
    const text = operandText(arg)
    if (options && text === '--') options = false
    else if (!(options && text.startsWith('-') && text !== '-')) words.push(arg)
  }
  return words
}

// Print a symlink's target, GNU readlink semantics.
//
// The three canonicalizing flags differ only in how much of the resolved
// path has to exist: -m requires nothing, -f requires every component
// but the last, and -e requires all of it. A path that falls short
// prints nothing and exits 1, and says why under -v (the last of -q, -s
// and -v wins).
export async function handleReadlink(
  namespace: Namespace,
  dispatch: DispatchFn,
  session: SessionState,
  args: (string | PathSpec)[],
): Promise<Result> {
  const [, fl, refused] = parseLine('readlink', args, session.cwd)
  if (refused !== null) return refused
  const operands = operandWords(args)
  if (operands.length === 0) {
    const error = missingOperandError('readlink', null)
    return fail('readlink', `${error.message}\n`, error.exitCode)
  }
  const canon = fl
    .typedOrder('canonicalize', 'canonicalize_existing', 'canonicalize_missing')
    .at(-1)
  const mode = canon === undefined ? null : (CANONICAL_MODES[canon] ?? null)
  const verbose = fl.typedOrder('quiet', 'silent', 'verbose').at(-1) === 'verbose'
  const errors: string[] = []
  let newline = !fl.asBool('no_newline')
  if (operands.length > 1 && !newline) {
    errors.push('readlink: ignoring --no-newline with multiple arguments\n')
    newline = true
  }
  const follow = (v: string): string => namespace.follow(v)
  const readlink = (v: string): string | null => namespace.readlink(v)
  const lines: string[] = []
  let exitCode = 0
  for (const op of operands) {
    const absOp = operandAbs(namespace, op, session.cwd)
    const spec = PathSpec.fromStrPath(op, undefined, session.cwd)
    // The link entry is namespace state behind the dispatcher: session grants
    // and admission policies decide whether this session may read the
    // target at all, so a link operand clears it even under -f, -e and -m.
    // EINVAL (not a link), a refusal and a failed walk all land on GNU
    // readlink's exit 1, said only under -v.
    try {
      if (mode !== null) {
        if (namespace.isLink(absOp)) await dispatch('readlink', PathSpec.fromStrPath(absOp))
        lines.push(
          await canonicalize(
            spec.rawPath,
            session.cwd,
            mode,
            false,
            readlink,
            dispatchStat(dispatch),
            session.visibility,
          ),
        )
        continue
      }
      const refusal =
        spec.walkError !== null
          ? walkRefusal(spec)
          : await dotRefusal(dispatchStat(dispatch), spec, follow)
      if (refusal !== null) throw refusal
      const [found] = await dispatch('readlink', PathSpec.fromStrPath(absOp))
      lines.push(found as string)
    } catch (err) {
      if (!readlinkRefused(err)) throw err
      exitCode = 1
      if (verbose) {
        const line = fsErrorLine('readlink', spec.rawPath, err)
        const code = (err as { code?: unknown }).code
        errors.push(
          fsStrerror(err) === null && code === 'EINVAL'
            ? `${line.trimEnd()}: ${posixPhrase('EINVAL')}\n`
            : line,
        )
      }
    }
  }
  const end = newline ? (fl.asBool('zero') ? '\0' : '\n') : ''
  const stderr = errors.join('')
  if (lines.length === 0) return result('readlink', { exitCode, stderr })
  const text = lines.map((l) => l + end).join('')
  return result('readlink', { out: encodeText(text), exitCode, stderr })
}
