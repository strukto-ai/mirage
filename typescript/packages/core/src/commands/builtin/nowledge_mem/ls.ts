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
import { nowledgeMemLsStats, nowledgeMemPath } from '../../../core/nowledge_mem/client.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { FileType, ResourceName, type FileStat, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { humanSize } from '../utils/formatting.ts'

const ENC = new TextEncoder()

function formatName(entry: FileStat, classify: boolean): string {
  const path = typeof entry.extra.path === 'string' ? entry.extra.path : entry.name
  const name = path.split('/').pop() ?? entry.name
  return classify && entry.type === FileType.DIRECTORY ? `${name}/` : name
}

function formatLong(entry: FileStat, human: boolean): string {
  const size = human ? humanSize(entry.size ?? 0) : String(entry.size ?? 0)
  const path = typeof entry.extra.path === 'string' ? entry.extra.path : entry.name
  const name = path.split('/').pop() ?? entry.name
  return `${entry.type ?? '-'}\t${size}\t${entry.modified ?? ''}\t${name}`
}

async function lsCommand(
  accessor: NowledgeMemAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const long = opts.flags.args_l === true && opts.flags.args_1 !== true
  const human = opts.flags.h === true
  const classify = opts.flags.F === true
  const p = paths[0]
  const path = p !== undefined ? nowledgeMemPath(p.original, p.prefix) : '/'
  const entries = await nowledgeMemLsStats(accessor, path)
  const lines = entries.map((entry) =>
    long ? formatLong(entry, human) : formatName(entry, classify),
  )
  const out: ByteSource = ENC.encode(lines.join('\n'))
  return [out, new IOResult()]
}

export const NOWLEDGE_MEM_LS = command({
  name: 'ls',
  resource: ResourceName.NOWLEDGE_MEM,
  spec: specOf('ls'),
  fn: lsCommand,
})
