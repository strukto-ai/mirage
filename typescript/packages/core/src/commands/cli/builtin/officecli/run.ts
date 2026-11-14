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

import type { util } from 'zod'
import { IOResult } from '../../../../io/types.ts'
import { byteView } from '../../../../shell/bytes.ts'
import type { PathSpec } from '../../../../types.ts'
import { commandFiles } from '../../../builtin/generic_bind/files.ts'
import { StreamHost, hostedStream } from '../../../builtin/utils/stream_host.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { CommandSpec } from '../../../spec/types.ts'

/**
 * Run one officecli command through mirage-rs, which reads the workbook
 * from a host spool and writes it back through the mount that owns it,
 * every part the command leaves alone copied as it stands.
 */
export function runCommand(
  _accessor: unknown,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const spec = ctx.spec ?? new CommandSpec()
  const flags = new FlagView(ctx.flags, spec)
  const name = spec.name
  const [workbook] = paths
  if (workbook === undefined) throw new Error('officecli: the workbook operand is missing')
  const operands = [workbook]
  const config: Record<string, util.JSONType> = {
    command: name,
    file: byteView(workbook.rawPath),
    absolute: byteView(workbook.virtual),
    path: texts[0] ?? '/',
    json: flags.asBool('json'),
  }
  if (name === 'set') config.props = flags.asList('prop')
  if (name === 'create' || name === 'batch') config.force = flags.asBool('force')
  if (name === 'get') config.depth = flags.asInt('depth') ?? null
  if (name === 'query') config.find = flags.asStr('find') ?? null
  if (name === 'batch') {
    config.commands = flags.asStr('commands') ?? null
    config.stop_on_error = flags.asBool('stop_on_error')
    config.best_effort = flags.asBool('best_effort')
    const source = flags.asPath('input')
    if (source !== undefined && source.rawPath !== '-') {
      operands.push(source)
      config.input = byteView(source.rawPath)
      config.input_absolute = byteView(source.virtual)
    } else if (source !== undefined) {
      config.input = '-'
    }
  }
  const files = commandFiles(ctx, operands)
  const host = new StreamHost(operands, files.read, ctx, false)
  const io = new IOResult()
  return Promise.resolve([hostedStream('officecli', config, host, io, ctx.signal), io])
}
