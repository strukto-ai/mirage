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

import { versionLine } from '../../../../commands/spec/standard.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import type { JobTable } from '../../../../execution/job/index.ts'
import { WORKSPACE_MACHINE } from '../../../../execution/process/constants.ts'
import { shownMachine, shownPid } from '../../../../execution/process/types.ts'
import { IOResult } from '../../../../io/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import type { SessionView } from '../../../../view/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { jobResult } from '../jobspec.ts'
import { inScope, processScope, withMachine } from '../machine_view.ts'
import { programOf, running } from './shared.ts'

// Options that take nothing and change nothing here.
const ACCEPTED = 'cnxz'

/**
 * Print the pids of the named programs on one line, newest first, among those
 * `ps` shows; a line a machine, ending in it, for several. Any option it does
 * not know ends it with 1 and no word. Mirrors Python's `handle_pidof`.
 */
export async function handlePidof(
  jobTable: JobTable,
  parts: string[],
  session: SessionState | null = null,
  _view: SessionView | null = null,
): Promise<RedirectResult> {
  const cmdStr = parts.join(' ')
  let single = false
  let quiet = false
  let delimiter = ' '
  const omit = new Set<string>()
  let machine: string | null = null
  const names: string[] = []
  const words = parts.slice(1)
  let at = 0
  while (at < words.length) {
    const word = words[at] ?? ''
    at += 1
    if (word === '--machine' || word.startsWith('--machine=')) {
      if (word.includes('=')) {
        machine = word.slice('--machine='.length)
      } else {
        machine = words[at] ?? ''
        at += 1
      }
      continue
    }
    if (!word.startsWith('-') || word === '-') {
      names.push(word)
      continue
    }
    let letters = word.slice(1)
    while (letters !== '') {
      const flag = letters.charAt(0)
      letters = letters.slice(1)
      if (flag === 'V')
        return [
          encodeText(versionLine('pidof')),
          new IOResult(),
          new ExecutionNode({ command: cmdStr, exitCode: 0 }),
        ]
      if (flag === 's') {
        single = true
      } else if (flag === 'q') {
        quiet = true
      } else if (flag === 'd' || flag === 'o') {
        let value = letters
        if (letters === '') {
          value = words[at] ?? ''
          at += 1
        }
        letters = ''
        if (flag === 'd') delimiter = value
        else for (const pid of value.split(',')) omit.add(pid)
      } else if (!ACCEPTED.includes(flag)) {
        return jobResult(cmdStr, '', 1)
      }
    }
  }
  const scope = processScope(jobTable.processes, machine)
  if (scope === null) return jobResult(cmdStr, `pidof: ${machine ?? ''}: no such machine\n`, 1)
  const rows = await running(jobTable, session, scope)
  const lines: string[] = []
  let found = false
  const places = [WORKSPACE_MACHINE, ...scope.ids].filter((place) => inScope(scope, place))
  for (const place of scope.several ? places : ['']) {
    let pids: string[] = []
    for (const name of names) {
      const matched = rows
        .filter(
          (info) =>
            programOf(info) === name &&
            !omit.has(String(shownPid(info))) &&
            (place === '' || shownMachine(info) === place),
        )
        .map(shownPid)
        .sort((a, b) => b - a)
      pids = pids.concat(matched.map(String))
    }
    if (single) pids = pids.slice(0, 1)
    if (pids.length > 0) {
      found = true
      const text = pids.join(delimiter)
      lines.push(place === '' ? text : withMachine(text, place))
    }
  }
  const code = found ? 0 : 1
  return [
    encodeText(quiet ? '' : lines.map((line) => `${line}\n`).join('')),
    new IOResult({ exitCode: code }),
    new ExecutionNode({ command: cmdStr, exitCode: code }),
  ]
}
