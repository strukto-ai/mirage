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

import { lsModeString } from '../../../../commands/builtin/utils/formatting.ts'
import { UsageError } from '../../../../commands/errors.ts'
import { missingOperandError } from '../../../../commands/spec/usage.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import { isRefusal } from '../../../../errors/fs.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { FileStat, FileType, PathSpec } from '../../../../types.ts'
import { DEFAULT_DIR_MODE, DEFAULT_FILE_MODE, parseChmod } from '../../../../utils/mode.ts'
import { shellQuoteAlways } from '../../../../utils/quote.ts'
import type { Namespace } from '../../../mount/namespace/namespace.ts'
import type { SessionState } from '../../../session/session.ts'
import { expandOperands, fail, parseLine, result } from '../shared.ts'
import {
  type WalkEntry,
  beforeRecursiveChange,
  permissionError,
  preservesRoot,
  referenceOperands,
  referenceStat,
  resolveOperand,
  rootRefusal,
  setattrVia,
  traversal,
  unfollowedError,
  unreadError,
  verbosity,
  walkedName,
  walkStats,
} from './metadata.ts'

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

// chmod -v's report for a link it neither changes nor follows. Mirrors
// Python's link_line.
export function linkLine(name: string): string {
  return `neither symbolic link ${shellQuoteAlways(name)} nor referent has been changed\n`
}

// chmod MODE FILE...: set permission bits via setattr. Follows symlinks
// (GNU chmod always dereferences). Stored, not enforced: mount mode does
// real access control. -R walks the operand's subtree and applies the mode
// to every entry, skipping symlinks the way GNU does (a traversed link
// changes neither itself nor its referent); a command-line link to a
// directory is still followed and its target walked, unless -P leaves it,
// and -L follows every link. -v reports every file, -c the changed ones,
// and -f drops the per-file errors. --reference takes the mode of a file in
// place of MODE.
export async function handleChmod(
  namespace: Namespace,
  dispatch: DispatchFn,
  session: SessionState,
  args: readonly (string | PathSpec)[],
): Promise<RedirectResult> {
  const [parsed, fl, refused] = parseLine('chmod', args, session.cwd)
  if (refused !== null) return refused
  const links = namespace.sessionLinks(session)
  const reference = fl.asPath('reference')
  let operands = parsed.paths
  let modeText: string
  if (reference !== undefined) {
    operands = referenceOperands(parsed.texts, parsed.paths, session.cwd)
    if (operands.length === 0) {
      const error = missingOperandError('chmod', null)
      return fail('chmod', `${error.message}\n`, error.exitCode)
    }
    const source = await referenceStat(links, dispatch, 'chmod', reference)
    if (!(source instanceof FileStat)) return source
    const copied =
      source.mode ?? (source.type === FileType.DIRECTORY ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE)
    modeText = copied.toString(8)
  } else {
    const typed = parsed.texts[0]
    if (typed === undefined || parsed.paths.length === 0) {
      const error = missingOperandError('chmod', typed ?? null)
      return fail('chmod', `${error.message}\n`, error.exitCode)
    }
    modeText = typed
  }
  if (parseChmod(modeText, 0) === null) {
    return fail('chmod', `chmod: invalid mode: '${modeText}'\n`, 1)
  }

  const report = verbosity(fl)
  const walk = traversal(fl, 'H')
  const recursive = fl.asBool('recursive')
  const errors: string[] = []
  const out: string[] = []
  for (const target of await expandOperands(namespace, dispatch, operands)) {
    if (recursive && walk === 'P' && links.isLink(target.virtual)) {
      if (report === 'verbose') out.push(linkLine(target.rawPath))
      continue
    }
    const found = await resolveOperand(links, dispatch, 'chmod', target, errors)
    if (found === null) {
      if (report === 'verbose')
        out.push(`${shellQuoteAlways(target.rawPath)} could not be accessed\n`)
      continue
    }
    const [resolved, stat] = found
    if (recursive) {
      const refusal = rootRefusal('chmod', fl, target.rawPath, resolved)
      if (refusal !== null) {
        errors.push(refusal)
        continue
      }
      try {
        await beforeRecursiveChange(links.mounts(false), dispatch, resolved, 'chmod')
      } catch (err) {
        if (!(err instanceof UsageError)) throw err
        errors.push(`${err.message}\n`)
        continue
      }
    }
    const entries: WalkEntry[] = recursive
      ? await walkStats(links, dispatch, resolved, stat, walk === 'L', preservesRoot(fl))
      : [[resolved, stat, null]]
    for (const [path, entryStat, unread] of entries) {
      if (entryStat.type === FileType.SYMLINK) {
        const name = walkedName(target.rawPath, resolved, path)
        if (walk !== 'L') {
          if (report === 'verbose') out.push(linkLine(name))
        } else if (unread !== null) errors.push(unfollowedError('chmod', name, unread))
        else errors.push(rootRefusal('chmod', fl, name, PathSpec.fromStrPath('/')) ?? '')
        continue
      }
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
