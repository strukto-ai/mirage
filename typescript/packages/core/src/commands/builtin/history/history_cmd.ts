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

import type { HistoryAccessor } from '../../../accessor/history.ts'
import { renderHistoryListing } from '../../../core/history/render.ts'
import { IOResult } from '../../../io/types.ts'
import { type PathSpec } from '../../../types.ts'
import { command } from '../../config.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { ResourceName } from '../../../types.ts'

const ENC = new TextEncoder()

// Mirrors Python int(): trims surrounding whitespace, accepts an
// optional sign, requires all digits. Unlike Number.parseInt it rejects
// trailing garbage ("3abc") and decimals ("3.5"), matching bash, which
// treats those as a non-numeric argument.
function parseIntStrict(value: string): number | null {
  const trimmed = value.trim()
  if (!/^[+-]?\d+$/.test(trimmed)) return null
  return Number.parseInt(trimmed, 10)
}

function outOfRange(value: string): IOResult {
  return new IOResult({
    exitCode: 1,
    stderr: ENC.encode(`history: ${value}: history position out of range\n`),
  })
}

/**
 * GNU history builtin over the recorder.
 *
 * -a/-r/-w/-n are accepted no-ops: bash uses them to sync the in-memory
 * list with the histfile, but here both are the same store and always
 * in sync. -p prints its args verbatim; when -s and -p are combined, -s
 * wins and nothing is printed (bash-verified).
 */
async function historyFn(
  accessor: HistoryAccessor,
  _paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const observer = accessor.observer
  if (opts.sessionId === undefined) {
    throw new Error("history requires the caller's session id")
  }
  const session = opts.sessionId
  const flags = opts.flags
  const c = flags.c === true
  const s = flags.s === true
  const p = flags.p === true
  const a = flags.a === true
  const r = flags.r === true
  const w = flags.w === true
  const n = flags.n === true
  const d = typeof flags.d === 'string' ? flags.d : undefined

  if (c) await observer.logClear(session)
  if (d !== undefined) {
    const offset = parseIntStrict(d)
    if (offset === null) return [null, outOfRange(d)]
    const visible = await observer.sessionCommandEvents(session)
    const idx = offset > 0 ? offset - 1 : visible.length + offset
    if (idx < 0 || idx >= visible.length) return [null, outOfRange(d)]
    await observer.logDelete(session, offset)
  }
  if (s && texts.length > 0) {
    await observer.logCommandText(texts.join(' '), session, '', opts.cwd)
  }
  if (p && !s) {
    const out = texts.length > 0 ? texts.join('\n') + '\n' : ''
    return [ENC.encode(out), new IOResult()]
  }
  if (c || d !== undefined || s || a || r || w || n) {
    return [null, new IOResult()]
  }
  if (texts.length > 1) {
    return [
      null,
      new IOResult({ exitCode: 1, stderr: ENC.encode('history: too many arguments\n') }),
    ]
  }
  let count: number | undefined
  if (texts.length > 0) {
    const arg = texts[0] ?? ''
    const parsed = parseIntStrict(arg)
    if (parsed === null) {
      return [
        null,
        new IOResult({
          exitCode: 1,
          stderr: ENC.encode(`history: ${arg}: numeric argument required\n`),
        }),
      ]
    }
    count = parsed
  }
  const events = await observer.sessionCommandEvents(session)
  return [ENC.encode(renderHistoryListing(events, count)), new IOResult()]
}

export const HISTORY_HISTORY = command({
  name: 'history',
  resource: ResourceName.HISTORY,
  spec: specOf('history'),
  fn: historyFn,
})
