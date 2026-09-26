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

import { DEFAULT_UMASK } from '../../../../context/session_context.ts'
import { IOResult } from '../../../../io/types.ts'
import type { FileStat, SetAttrFields } from '../../../../types.ts'
import { FileType, PathSpec } from '../../../../types.ts'
import {
  fsStrerror,
  isEnoent,
  isEnotdir,
  isFsError,
  isMissingOp,
} from '../../../../utils/errors.ts'
import { CycleError, resolvePath } from '../../../../utils/path.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import type { Namespace } from '../../../mount/namespace/namespace.ts'
import type { SessionState } from '../../../session/session.ts'
import { expandOperands, fail, finish, splitValueFlags } from '../shared.ts'
import {
  isReadOnlyError,
  nowIso,
  permissionError,
  parseTouchStamp,
  setattrLink,
  setattrVia,
} from './metadata.ts'
import type { Result } from '../types.ts'

// touch: set access/modification times, creating missing files. GNU flags:
// -a/-m select which times, -c no-create, -h no-dereference (writes the
// link node's own mtime), -t STAMP / -d STRING supply the time, -r FILE
// copies times from a reference file.
export async function handleTouch(
  namespace: Namespace,
  dispatch: DispatchFn,
  session: SessionState,
  args: readonly (string | PathSpec)[],
): Promise<Result> {
  const { flags, values, operands, bad } = splitValueFlags(args, 'acmh', 'tdr')
  if (bad !== null) return fail('touch', `touch: invalid option -- '${bad}'\n`, 2)
  if (operands.length === 0) return fail('touch', 'touch: missing file operand\n', 1)

  let stamp: string | null
  try {
    stamp = parseTouchStamp(values.get('t') ?? null, values.get('d') ?? null)
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    return fail('touch', `touch: invalid date format '${text}'\n`, 1)
  }
  const refText = values.get('r')
  if (stamp === null && refText !== undefined) {
    const ref = PathSpec.fromStrPath(resolvePath(refText, session.cwd))
    try {
      const [refStat] = await dispatch('stat', ref)
      stamp = (refStat as FileStat).modified
    } catch (err) {
      const strerror = isEnoent(err) || isEnotdir(err) ? fsStrerror(err) : null
      if (strerror !== null) {
        return fail('touch', `touch: failed to get attributes of '${refText}': ${strerror}\n`)
      }
      throw err
    }
  }
  stamp ??= nowIso()

  const setAtime = flags.has('a') || !flags.has('m')
  const setMtime = flags.has('m') || !flags.has('a')

  const errors: string[] = []
  const writes: Record<string, Uint8Array> = {}
  for (const target of await expandOperands(namespace, operands)) {
    if (namespace.isMountRoot(target.virtual)) {
      errors.push(`touch: cannot touch '${target.rawPath}': Is a directory\n`)
      continue
    }
    if (flags.has('h') && namespace.isLink(target.virtual)) {
      await setattrLink(dispatch, target, { mtime: stamp })
      continue
    }
    let virtual: string
    try {
      virtual = namespace.follow(target.virtual)
    } catch (err) {
      if (err instanceof CycleError) {
        errors.push(`touch: cannot touch '${target.rawPath}': Too many levels of symbolic links\n`)
        continue
      }
      throw err
    }
    const resolved = PathSpec.fromStrPath(virtual)
    // `x/` is `x/.`, so touch never creates through a trailing slash: it
    // sets times on a directory that has to be there already, and GNU
    // words that refusal ("setting times of") differently from its
    // create-path one ("cannot touch").
    if (target.rawPath.endsWith('/')) {
      let slashed: FileStat
      try {
        ;[slashed] = (await dispatch('stat', resolved)) as [FileStat, unknown]
      } catch (err) {
        if (!isFsError(err)) throw err
        errors.push(`touch: setting times of '${target.rawPath}': ${String(fsStrerror(err))}\n`)
        continue
      }
      if (slashed.type !== FileType.DIRECTORY) {
        errors.push(`touch: setting times of '${target.rawPath}': Not a directory\n`)
        continue
      }
    }
    try {
      try {
        await dispatch('stat', resolved)
      } catch (err) {
        // -c never opens the file, so GNU meets the bad parent when it sets
        // the times, and says so in those words.
        if (isEnotdir(err) && flags.has('c')) {
          errors.push(`touch: setting times of '${target.rawPath}': Not a directory\n`)
          continue
        }
        if (!isEnoent(err)) throw err
        if (flags.has('c')) continue
        try {
          await dispatch('write', resolved, [new Uint8Array(0)])
        } catch (werr) {
          // Stat-only backend (e.g. an API surface): creation is
          // impossible, which GNU reports as EROFS.
          if (!isMissingOp(werr, 'write')) throw werr
          errors.push(`touch: cannot touch '${target.rawPath}': Read-only file system\n`)
          continue
        }
        writes[resolved.virtual] = new Uint8Array(0)
        // A file touch creates is 0666 under the session's umask; only
        // a mask away from bash's default is worth a mode write, since
        // 644 is what a fresh file renders as.
        if (session.umask !== DEFAULT_UMASK) {
          const fields: SetAttrFields = { mode: 0o666 & ~session.umask }
          if (setAtime) fields.atime = stamp
          if (setMtime) fields.mtime = stamp
          await setattrVia(dispatch, resolved, fields)
          continue
        }
      }
      const fields: SetAttrFields = {}
      if (setAtime) fields.atime = stamp
      if (setMtime) fields.mtime = stamp
      await setattrVia(dispatch, resolved, fields)
    } catch (err) {
      if (isReadOnlyError(err)) {
        const action = flags.has('c') ? 'setting times of' : 'cannot touch'
        errors.push(permissionError('touch', action, target, err))
        continue
      }
      // A destination whose parent chain is not all directories is one
      // failed operand, not an aborted command: GNU reports it and touches
      // the rest. Caught here rather than around the write because backends
      // disagree about which call refuses first (an object store answers
      // stat with ENOENT and fails the write; a filesystem or a keyed store
      // answers stat itself with ENOTDIR).
      if (!isFsError(err)) throw err
      errors.push(`touch: cannot touch '${target.rawPath}': ${String(fsStrerror(err))}\n`)
    }
  }
  return finish('touch', errors, new IOResult({ writes }))
}
