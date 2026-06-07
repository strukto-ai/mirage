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
import { nowledgeMemGrep, nowledgeMemPath } from '../../../core/nowledge_mem/client.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'

const ENC = new TextEncoder()

function getPattern(
  texts: readonly string[],
  flags: Record<string, string | boolean>,
): string | null {
  if (typeof flags.e === 'string') return flags.e
  return texts[0] ?? null
}

async function grepCommand(
  accessor: NowledgeMemAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const pattern = getPattern(texts, opts.flags)
  if (pattern === null) {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('grep: missing pattern\n') })]
  }
  const p = paths[0]
  const path = p !== undefined ? nowledgeMemPath(p.original, p.prefix) : '/memories'
  const parsedLimit =
    typeof opts.flags.m === 'string' ? Number.parseInt(opts.flags.m, 10) : undefined
  const limit =
    parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : accessor.defaultLimit
  const matches = await nowledgeMemGrep(accessor, path, pattern, {
    ...(limit !== undefined ? { limit } : {}),
  })
  const filesOnly = opts.flags.args_l === true || opts.flags.l === true
  const lineNumbers = opts.flags.n === true
  let lines: string[]
  if (filesOnly) {
    lines = [...new Set(matches.map((match) => match.path))]
  } else {
    lines = matches.map((match) =>
      lineNumbers ? `${match.path}:${match.line}:${match.match}` : `${match.path}:${match.match}`,
    )
  }
  const out: ByteSource = ENC.encode(lines.join('\n'))
  return [out, new IOResult({ exitCode: lines.length === 0 ? 1 : 0 })]
}

export const NOWLEDGE_MEM_GREP = command({
  name: 'grep',
  resource: ResourceName.NOWLEDGE_MEM,
  spec: specOf('grep'),
  fn: grepCommand,
})
