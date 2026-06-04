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

import type { NowledgeMemAccessor } from '../../../accessor/nowledge_mem.ts'
import { nowledgeMemPath, nowledgeMemStat } from '../../../core/nowledge_mem/client.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { FileType, ResourceName, type FileStat, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'

const ENC = new TextEncoder()

const TYPE_LABELS: Record<string, string> = {
  [FileType.DIRECTORY]: 'directory',
  [FileType.TEXT]: 'regular file',
  [FileType.BINARY]: 'regular file',
  [FileType.JSON]: 'regular file',
  [FileType.CSV]: 'regular file',
  [FileType.PDF]: 'regular file',
}

function formatStat(fmt: string, stat: FileStat): string {
  return fmt.replace(/%(.)/g, (_, spec: string) => {
    if (spec === 'n') return stat.name
    if (spec === 's') return String(stat.size ?? 0)
    if (spec === 'F')
      return stat.type !== null ? (TYPE_LABELS[stat.type] ?? 'regular file') : 'regular file'
    if (spec === 'y') return stat.modified ?? ''
    return '?'
  })
}

async function statCommand(
  accessor: NowledgeMemAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('stat: missing operand\n') })]
  }
  const fmt =
    typeof opts.flags.c === 'string'
      ? opts.flags.c
      : typeof opts.flags.f === 'string'
        ? opts.flags.f
        : null
  const lines: string[] = []
  for (const p of paths) {
    const stat = await nowledgeMemStat(accessor, nowledgeMemPath(p.original, p.prefix))
    if (fmt !== null) {
      lines.push(formatStat(fmt, stat))
    } else {
      lines.push(
        `name=${stat.name} size=${String(stat.size)} modified=${String(stat.modified)} type=${String(stat.type)}`,
      )
    }
  }
  const out: ByteSource = ENC.encode(lines.join('\n'))
  return [out, new IOResult()]
}

export const NOWLEDGE_MEM_STAT = command({
  name: 'stat',
  resource: ResourceName.NOWLEDGE_MEM,
  spec: specOf('stat'),
  fn: statCommand,
})
