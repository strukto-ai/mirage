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

import { resolvePath } from '../../../../utils/path.ts'
import { IOResult } from '../../../../io/types.ts'
import { PathSpec } from '../../../../types.ts'
import { FileType } from '../../../../types.ts'
import { CycleError } from '../../../../utils/path.ts'
import { posixNormpath } from '../../../../utils/path.ts'
import type { SessionState } from '../../../session/session.ts'
import { changeDir, logicalCwd } from '../../../session/shell_dirs.ts'
import { ExecutionNode } from '../../../types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { toScope, scopePath } from '../scope.ts'
import { joinPath, resolveTarget, typedPath } from './dirs.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { CD_OPTIONS, CD_USAGE } from './constants.ts'
import { splitModeOptions } from './dirs.ts'
import { classifyBarePath } from '../../../expand/classify/index.ts'
import { homeDir } from '../../../session/shell_dirs.ts'

function cdpathSearchable(target: string): boolean {
  if (target.startsWith('/') || target.startsWith('./') || target.startsWith('../')) {
    return false
  }
  return target !== '.' && target !== '..'
}

// `cwd` is the directory a relative operand joins to: the logical cwd
// under -L, the physical one under -P.
function cdCandidates(
  raw: string,
  cdpathTarget: string | null,
  session: SessionState,
  cwd: string,
): [string, boolean][] {
  const fallback = joinPath(raw, cwd)
  const cdpath = session.env.CDPATH
  if (!cdpath || !cdpathTarget || !cdpathSearchable(cdpathTarget)) {
    return [[fallback, false]]
  }
  const out: [string, boolean][] = []
  for (const entry of cdpath.split(':')) {
    const base = entry ? resolvePath(entry, cwd) : cwd
    out.push([joinPath(cdpathTarget, base), entry !== ''])
  }
  out.push([fallback, false])
  return out
}

export async function handleCd(
  dispatch: DispatchFn,
  isMountRoot: (path: string) => boolean,
  path: string | PathSpec,
  session: SessionState,
  printPath = false,
  cdpathTarget: string | null = null,
  links: Map<string, string> | null = null,
  physical = false,
): Promise<Result> {
  const raw = scopePath(path)
  const table = links ?? new Map<string, string>()
  // -L joins a relative operand to the name the shell is *spelling*, -P
  // to the one it resolves to: from a logical /data/lk whose target is
  // /data/deep/real, bash sends `cd -L ..` to /data and `cd -P ..` to
  // /data/deep.
  const base = physical ? session.cwd : logicalCwd(session)
  const candidates = cdCandidates(typedPath(path), cdpathTarget, session, base)
  let error: string | null = null
  for (const [candidate, announce] of candidates) {
    // The logical name is the candidate with `..` simplified textually
    // and links left alone; the physical one follows them. -P collapses
    // the pair, which is why `cd -P .` re-spells the cwd.
    const spelled = posixNormpath(candidate)
    let logical = spelled
    let resolved = logical
    if (table.size > 0) {
      try {
        resolved = resolveTarget(candidate, table, physical)
      } catch (exc) {
        if (exc instanceof CycleError) {
          error = `cd: ${raw}: Too many levels of symbolic links\n`
          continue
        }
        throw exc
      }
    }
    if (physical) logical = resolved
    if (resolved === '/') {
      return cdSuccess(session, '/', logical, spelled, raw, printPath || announce)
    }
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
        return cdSuccess(session, resolved, logical, spelled, raw, printPath || announce)
      }
      error = `cd: ${raw}: No such file or directory\n`
      continue
    }
    if (stat.type !== FileType.DIRECTORY) {
      error = `cd: ${raw}: Not a directory\n`
      continue
    }
    return cdSuccess(session, resolved, logical, spelled, raw, printPath || announce)
  }
  const err = new TextEncoder().encode(error ?? `cd: ${raw}: No such file or directory\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: err }),
    new ExecutionNode({ command: `cd ${raw}`, exitCode: 1, stderr: err }),
  ]
}

// Land the session on `resolved` and print what GNU prints. `logical` is
// the name to remember as the cwd's spelling — `resolved` under -P, which
// collapses the pair. `spelled` is the path as selected, `..` simplified
// but links intact: what GNU announces, and NOT the same as `logical`
// under -P, since `cd -P -` prints /tmp/lk and then lands on
// /tmp/deep/real, and a -P $CDPATH hit prints /opt/c/lnk while landing on
// /opt/c/t.
function cdSuccess(
  session: SessionState,
  resolved: string,
  logical: string,
  spelled: string,
  raw: string,
  printPath: boolean,
): Result {
  changeDir(session, resolved, logical)
  const out = printPath ? new TextEncoder().encode(`${spelled}\n`) : null
  return [out, new IOResult(), new ExecutionNode({ command: `cd ${raw}`, exitCode: 0 })]
}

/**
 * The `cd` arm: split -L/-P, pick the target, then move. `set -P`
 * (`set -o physical`) is the session-wide version of the per-command
 * flag, and GNU applies it to both `cd` and `pwd`.
 */
export async function cdBuiltin(call: BuiltinCall): Promise<Result> {
  const { session, dispatch, registry, namespace } = call
  const shellPhysical = session.shellOptions.physical === true
  const {
    operands: cdOperands,
    bad,
    physical,
  } = splitModeOptions([...call.argv.operands], CD_OPTIONS, shellPhysical)
  const links = namespace.symlinkTargets()
  if (bad !== null) {
    const err = new TextEncoder().encode(`cd: -${bad}: invalid option\n${CD_USAGE}`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'cd', exitCode: 2, stderr: err }),
    ]
  }
  if (cdOperands.length > 1) {
    const err = new TextEncoder().encode('cd: too many arguments\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'cd', exitCode: 1, stderr: err }),
    ]
  }
  if (cdOperands.length === 0) {
    const home = homeDir(session)
    if (home === null) {
      const err = new TextEncoder().encode('cd: HOME not set\n')
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: 'cd', exitCode: 1, stderr: err }),
      ]
    }
    return handleCd(
      dispatch,
      (p) => registry.isMountRoot(p),
      home,
      session,
      false,
      null,
      links,
      physical,
    )
  }
  const raw = cdOperands[0]
  const rawStr = raw instanceof PathSpec ? raw.virtual : String(raw)
  if (rawStr === '-') {
    const old = session.env.OLDPWD
    if (!old) {
      const err = new TextEncoder().encode('cd: OLDPWD not set\n')
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: 'cd -', exitCode: 1, stderr: err }),
      ]
    }
    return handleCd(
      dispatch,
      (p) => registry.isMountRoot(p),
      old,
      session,
      true,
      null,
      links,
      physical,
    )
  }
  let path: string | PathSpec
  let cdpathTarget: string
  if (raw instanceof PathSpec) {
    path = raw
    cdpathTarget = raw.rawPath
  } else if (rawStr.startsWith('/')) {
    path = rawStr
    cdpathTarget = rawStr
  } else {
    path = classifyBarePath(rawStr, registry, session.cwd)
    cdpathTarget = rawStr
  }
  return handleCd(
    dispatch,
    (p) => registry.isMountRoot(p),
    path,
    session,
    false,
    cdpathTarget,
    links,
    physical,
  )
}
