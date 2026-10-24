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

import type { FileStat, PathSpec } from '../../../../types.ts'
import { FileType } from '../../../../types.ts'
import { DEFAULT_DIR_MODE, DEFAULT_FILE_MODE, parseChmod } from '../../../../utils/mode.ts'
import { lsModeString } from '../../../../commands/builtin/utils/formatting.ts'
import { missingOperandError } from '../../../../commands/spec/usage.ts'
import { beforeFullScan } from '../../../../commands/builtin/utils/tree.ts'
import { UsageError } from '../../../../commands/errors.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { shellQuoteAlways } from '../../../../utils/quote.ts'
import type { Namespace } from '../../../mount/namespace/namespace.ts'
import type { SessionState } from '../../../session/session.ts'
import { expandOperands, fail, parseLine, result } from '../shared.ts'
import {
  type WalkEntry,
  isRefusal,
  permissionError,
  resolveOperand,
  setattrVia,
  unreadError,
  verbosity,
  walkStats,
  walkedName,
} from './metadata.ts'
import type { Result } from '../types.ts'
import { encodeText } from '../../../../shell/bytes.ts'

// chmod's report for one file, worded as GNU chmod 9.7 prints it. Mirrors
// Python's mode_line.
export function modeLine(name: string, stat: FileStat, mode: number, failed: boolean): string {
  const old = stat.mode ?? 0
  const shown = shellQuoteAlways(name)
  const perms = lsModeString(stat.with({ mode })).slice(1)
  const newOctal = mode.toString(8).padStart(4, '0')
  if (!failed && old === mode) return `mode of ${shown} retained as ${newOctal} (${perms})\n`
  const was = lsModeString(stat.with({ mode: old })).slice(1)
  const oldOctal = old.toString(8).padStart(4, '0')
  const lead = failed ? `failed to change mode of ${shown} from` : `mode of ${shown} changed from`
  return `${lead} ${oldOctal} (${was}) to ${newOctal} (${perms})\n`
}

// chmod MODE FILE...: set permission bits via setattr. Follows symlinks
// (GNU chmod always dereferences). Stored, not enforced: mount mode does
// real access control. -R walks the operand's subtree and applies the mode
// to every entry, skipping symlinks the way GNU does (a traversed link
// changes neither itself nor its referent); a command-line link to a
// directory is still followed and its target walked. -v reports every
// file, -c the changed ones, and -f drops the per-file errors.
export async function handleChmod(
  namespace: Namespace,
  dispatch: DispatchFn,
  session: SessionState,
  args: readonly (string | PathSpec)[],
): Promise<Result> {
  const [parsed, fl, refused] = parseLine('chmod', args, session.cwd)
  if (refused !== null) return refused
  const modeText = parsed.texts[0]
  if (modeText === undefined || parsed.paths.length === 0) {
    const error = missingOperandError('chmod', modeText ?? null)
    return fail('chmod', `${error.message}\n`, error.exitCode)
  }
  if (parseChmod(modeText, 0) === null) {
    return fail('chmod', `chmod: invalid mode: '${modeText}'\n`, 1)
  }

  const report = verbosity(fl)
  const errors: string[] = []
  const out: string[] = []
  const links = namespace.sessionLinks(session)
  for (const target of await expandOperands(namespace, dispatch, parsed.paths)) {
    const found = await resolveOperand(links, dispatch, 'chmod', target, errors)
    if (found === null) {
      if (report === 'verbose')
        out.push(`${shellQuoteAlways(target.rawPath)} could not be accessed\n`)
      continue
    }
    const [resolved, stat] = found
    if (fl.asBool('recursive')) {
      // The mount is asked before anything changes, as for rm -r: a
      // change cut short would leave a tree that looks done.
      try {
        await beforeFullScan(dispatch, resolved, 'chmod')
      } catch (err) {
        if (!(err instanceof UsageError)) throw err
        errors.push(`${err.message}\n`)
        continue
      }
    }
    const entries: WalkEntry[] = fl.asBool('recursive')
      ? await walkStats(links, dispatch, resolved, stat)
      : [[resolved, stat, null]]
    for (const [path, entryStat, unread] of entries) {
      // Backends without a mode default to what ls renders: 755 for
      // directories, 644 for files (symbolic clauses build on this).
      const pathStat =
        entryStat.mode !== null
          ? entryStat
          : entryStat.with({
              mode: entryStat.type === FileType.DIRECTORY ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE,
            })
      const current = pathStat.mode ?? 0
      const newMode = parseChmod(modeText, current)
      if (newMode === null) {
        return fail('chmod', `chmod: invalid mode: '${modeText}'\n`, 1)
      }
      const name = walkedName(target.rawPath, resolved, path)
      let failed = false
      try {
        await setattrVia(dispatch, path, { mode: newMode })
      } catch (err) {
        if (!isRefusal(err)) throw err
        errors.push(permissionError('chmod', 'changing permissions of', name, err))
        failed = true
      }
      if (report === 'verbose' || (report === 'changes' && !failed && newMode !== current)) {
        out.push(modeLine(name, pathStat, newMode, failed))
      }
      if (unread !== null) errors.push(unreadError('chmod', name, unread))
    }
  }
  const quiet = fl.asBool('silent') || fl.asBool('quiet')
  const text = out.join('')
  return result('chmod', {
    out: text === '' ? null : encodeText(text),
    exitCode: errors.length > 0 ? 1 : 0,
    ...(quiet ? {} : { stderr: errors.join('') }),
  })
}
