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

import { PathSpec } from '../../../../types.ts'
import { CycleError, norm } from '../../../../utils/path.ts'
import { PolicyDenied } from '../../../../policy/index.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import type { Namespace } from '../../../mount/namespace/namespace.ts'
import type { SessionState } from '../../../session/session.ts'
import { absPath, fail, result, splitFlags } from '../shared.ts'
import { pathExists } from './probe.ts'
import type { Result } from '../types.ts'

// Any filesystem answer other than a target: a refusal (session view or
// policy), EINVAL (not a link), ENOENT (absent, which is what a hidden
// path answers). All of them land on GNU readlink's silent exit 1, so
// this matches python's `except OSError` rather than naming errnos one
// at a time — a list would silently print a raw path the first time a
// door answered with an errno nobody had added yet.
function readlinkRefused(err: unknown): boolean {
  if (err instanceof PolicyDenied) return true
  return typeof (err as { code?: unknown }).code === 'string'
}

// Print a symlink's target, GNU readlink semantics.
//
// The three canonicalizing flags differ only in how much of the resolved
// path has to exist: -m requires nothing, -f requires every component
// but the last, and -e requires all of it. A path that falls short
// prints nothing and exits 1.
export async function handleReadlink(
  namespace: Namespace,
  dispatch: DispatchFn,
  session: SessionState,
  args: (string | PathSpec)[],
): Promise<Result> {
  const [flags, operands] = splitFlags(args, 'fenm')
  if (operands.length === 0) {
    return fail('readlink', 'readlink: missing operand\n')
  }
  const canonical = flags.has('f') || flags.has('e') || flags.has('m')
  const lines: string[] = []
  let exitCode = 0
  for (const op of operands) {
    const absOp = absPath(op, session.cwd)
    if (canonical) {
      // -f/-e/-m canonicalize: resolve every symlink (including a trailing
      // one) and normalize the path, GNU realpath-style. A link operand
      // still clears the op door first: -m probes nothing, so without
      // this a scoped session read an ungranted link's target out of
      // the resolved path.
      if (namespace.isLink(absOp)) {
        try {
          await dispatch('readlink', PathSpec.fromStrPath(absOp))
        } catch (err) {
          if (!readlinkRefused(err)) throw err
          exitCode = 1
          continue
        }
      }
      let resolved: string
      try {
        resolved = norm(namespace.follow(absOp))
      } catch (err) {
        if (!(err instanceof CycleError)) throw err
        exitCode = 1
        continue
      }
      const probe = flags.has('e')
        ? resolved
        : flags.has('f')
          ? resolved.slice(0, resolved.lastIndexOf('/')) || '/'
          : null
      if (probe !== null && !(await pathExists(dispatch, probe))) {
        exitCode = 1
        continue
      }
      lines.push(resolved)
      continue
    }
    // The link entry is namespace state behind the op door: session
    // grants and admission policies decide whether this session may
    // read the target at all.
    let target: string
    try {
      const [found] = await dispatch('readlink', PathSpec.fromStrPath(absOp))
      target = found as string
    } catch (err) {
      if (!readlinkRefused(err)) throw err
      exitCode = 1
      continue
    }
    lines.push(target)
  }
  if (lines.length === 0) return result('readlink', { exitCode })
  const text = flags.has('n') ? lines.join('') : lines.map((l) => l + '\n').join('')
  return result('readlink', { out: new TextEncoder().encode(text), exitCode })
}
