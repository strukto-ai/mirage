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

import type { FileStat } from '../../../../types.ts'
import { FileType, PathSpec } from '../../../../types.ts'
import { fsStrerror, isEnoent, isEnotdir } from '../../../../utils/errors.ts'
import { DEFAULT_DIR_MODE, DEFAULT_FILE_MODE, parseChmod } from '../../../../utils/mode.ts'
import { CycleError } from '../../../../utils/path.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import type { Namespace } from '../../../mount/namespace/namespace.ts'
import { expandOperands, fail, finish, splitValueFlags } from '../shared.ts'
import { isReadOnlyError, permissionError, setattrVia, walkStats } from './metadata.ts'
import type { Result } from '../types.ts'

// chmod MODE FILE...: set permission bits via setattr. Follows symlinks
// (GNU chmod always dereferences). Stored, not enforced: mount mode does
// real access control. -R walks the operand's subtree and applies the mode
// to every entry, skipping symlinks the way GNU does (a traversed link
// changes neither itself nor its referent); a command-line link to a
// directory is still followed and its target walked.
export async function handleChmod(
  namespace: Namespace,
  dispatch: DispatchFn,
  args: readonly (string | PathSpec)[],
): Promise<Result> {
  const { flags, operands, bad } = splitValueFlags(args, 'Rvf', '')
  if (bad !== null) return fail('chmod', `chmod: invalid option -- '${bad}'\n`, 2)
  if (operands.length < 2) return fail('chmod', 'chmod: missing operand\n', 2)
  const first = operands[0]
  if (first === undefined) return fail('chmod', 'chmod: missing operand\n', 2)
  const modeText = first instanceof PathSpec ? first.virtual : first
  if (parseChmod(modeText, 0) === null) {
    return fail('chmod', `chmod: invalid mode: '${modeText}'\n`, 1)
  }

  const recursive = flags.has('R')
  const errors: string[] = []
  for (const target of await expandOperands(namespace, operands.slice(1))) {
    let virtual: string
    try {
      virtual = namespace.follow(target.virtual)
    } catch (err) {
      if (err instanceof CycleError) {
        errors.push(`chmod: cannot access '${target.rawPath}': Too many levels of symbolic links\n`)
        continue
      }
      throw err
    }
    const resolved = PathSpec.fromStrPath(virtual)
    let stat: FileStat
    try {
      const [result] = await dispatch('stat', resolved)
      stat = result as FileStat
    } catch (err) {
      const strerror = isEnoent(err) || isEnotdir(err) ? fsStrerror(err) : null
      if (strerror !== null) {
        errors.push(`chmod: cannot access '${target.rawPath}': ${strerror}\n`)
        continue
      }
      throw err
    }
    const entries: [PathSpec, FileStat][] = recursive
      ? await walkStats(namespace, dispatch, resolved, stat)
      : [[resolved, stat]]
    for (const [path, pathStat] of entries) {
      // Backends without a mode default to what ls renders: 755 for
      // directories, 644 for files (symbolic clauses build on this).
      const current =
        pathStat.mode ??
        (pathStat.type === FileType.DIRECTORY ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE)
      const newMode = parseChmod(modeText, current)
      if (newMode === null) {
        return fail('chmod', `chmod: invalid mode: '${modeText}'\n`, 1)
      }
      try {
        await setattrVia(dispatch, path, { mode: newMode })
      } catch (err) {
        if (!isReadOnlyError(err)) throw err
        errors.push(permissionError('chmod', 'changing permissions of', path, err))
      }
    }
  }
  return finish('chmod', errors)
}
