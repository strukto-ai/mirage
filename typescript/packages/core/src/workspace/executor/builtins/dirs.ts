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

import { resolvePath } from '../../../commands/spec/parser.ts'
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { FileType } from '../../../types.ts'
import { CycleError, MAX_SYMLINK_HOPS, resolveSymlinks } from '../../../utils/path.ts'
import { posixNormpath } from '../../expand/classify.ts'
import type { Session } from '../../session/session.ts'
import { changeDir } from '../../session/shell_dirs.ts'
import { ExecutionNode } from '../../types.ts'
import type { DispatchFn } from '../cross_mount.ts'
import { toScope, scopePath } from './scope.ts'
import type { Result } from './scope.ts'

// Resolve a combined `cd` target following symlinks per mode. Logical (-L,
// default) simplifies `..` textually first, then follows links; physical (-P)
// follows links first so `..` acts on the target. Both loop until stable.
// Throws CycleError on a symlink loop (ELOOP).
function resolveTarget(combined: string, links: Map<string, string>, physical: boolean): string {
  let p = physical ? combined : posixNormpath(combined)
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    const n = posixNormpath(resolveSymlinks(p, links))
    if (n === p) return n
    p = n
  }
  throw new CycleError(p)
}

function cdpathSearchable(target: string): boolean {
  if (target.startsWith('/') || target.startsWith('./') || target.startsWith('../')) {
    return false
  }
  return target !== '.' && target !== '..'
}

function cdCandidates(
  raw: string,
  cdpathTarget: string | null,
  session: Session,
): [string, boolean][] {
  const cwd = session.cwd
  const fallback = resolvePath(cwd, raw)
  const cdpath = session.env.CDPATH
  if (!cdpath || !cdpathTarget || !cdpathSearchable(cdpathTarget)) {
    return [[fallback, false]]
  }
  const out: [string, boolean][] = []
  for (const entry of cdpath.split(':')) {
    const base = entry ? resolvePath(cwd, entry) : cwd
    out.push([resolvePath(base, cdpathTarget), entry !== ''])
  }
  out.push([fallback, false])
  return out
}

export async function handleCd(
  dispatch: DispatchFn,
  isMountRoot: (path: string) => boolean,
  path: string | PathSpec,
  session: Session,
  printPath = false,
  cdpathTarget: string | null = null,
  links: Map<string, string> | null = null,
  physical = false,
): Promise<Result> {
  const raw = scopePath(path)
  const table = links ?? new Map<string, string>()
  const candidates = cdCandidates(raw, cdpathTarget, session)
  let error: string | null = null
  for (const [candidate, announce] of candidates) {
    let resolved = candidate
    if (table.size > 0) {
      try {
        resolved = resolveTarget(resolved, table, physical)
      } catch (exc) {
        if (exc instanceof CycleError) {
          error = `cd: ${raw}: Too many levels of symbolic links\n`
          continue
        }
        throw exc
      }
    }
    if (resolved === '/') return cdSuccess(session, '/', raw, printPath || announce)
    const scope = toScope(resolved)
    let stat: { type?: string } | null = null
    let notFound = false
    try {
      const [s] = await dispatch('stat', scope)
      stat = s as { type?: string } | null
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc)
      const code = (exc as { code?: string }).code
      if (code === 'ENOENT' || /not found|no such file/i.test(msg)) {
        notFound = true
      } else {
        error = `cd: ${raw}: ${msg}\n`
        continue
      }
    }
    if (stat === null || notFound) {
      if (isMountRoot(resolved)) {
        return cdSuccess(session, resolved, raw, printPath || announce)
      }
      error = `cd: ${raw}: No such file or directory\n`
      continue
    }
    if (stat.type !== FileType.DIRECTORY) {
      error = `cd: ${raw}: Not a directory\n`
      continue
    }
    return cdSuccess(session, resolved, raw, printPath || announce)
  }
  const err = new TextEncoder().encode(error ?? `cd: ${raw}: No such file or directory\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: err }),
    new ExecutionNode({ command: `cd ${raw}`, exitCode: 1, stderr: err }),
  ]
}

function cdSuccess(session: Session, resolved: string, raw: string, printPath: boolean): Result {
  changeDir(session, resolved)
  const out = printPath ? new TextEncoder().encode(`${resolved}\n`) : null
  return [out, new IOResult(), new ExecutionNode({ command: `cd ${raw}`, exitCode: 0 })]
}
