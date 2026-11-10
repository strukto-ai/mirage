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

import type { PathSpec } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { command, type CommandFnResult, type Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { quoteText } from '../../quote.ts'
import { CPUS, HOSTNAME } from '../constants.ts'
import { threadLimit } from '../utils/threads.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { extraOperandError } from '../../spec/usage.ts'

const ENC = new TextEncoder()
const DIGITS = /^[0-9]+$/

function nproc(
  _accessor: Accessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): CommandFnResult {
  const fl = new FlagView(ctx.flags, specOf('nproc'))
  const ignore = fl.asStr('ignore')
  if (ignore !== undefined && !DIGITS.test(ignore)) {
    const line = `nproc: invalid number: '${quoteText(ignore)}'\n`
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(line) })]
  }
  const extra = texts[0]
  if (extra !== undefined) throw extraOperandError('nproc', extra)
  const machine = fl.asStr('machine')
  if (machine !== undefined && machine !== HOSTNAME) {
    const line = `nproc: ${quoteText(machine)}: no such machine\n`
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(line) })]
  }
  const count = fl.asBool('all') ? CPUS : threadLimit(ctx.env ?? {}, CPUS)
  return [ENC.encode(`${String(Math.max(1, count - Number(ignore ?? 0)))}\n`), new IOResult()]
}

export const GENERAL_NPROC = command({ name: 'nproc', vfs: null, spec: specOf('nproc'), fn: nproc })
