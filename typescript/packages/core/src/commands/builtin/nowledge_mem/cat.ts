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
import { nowledgeMemPath, nowledgeMemRead } from '../../../core/nowledge_mem/client.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, Operand, OperandKind, Option } from '../../spec/types.ts'
import { readStdinAsync } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

const SPEC = new CommandSpec({
  options: [
    new Option({ short: '-n' }),
    new Option({ long: '--line', valueKind: OperandKind.TEXT }),
    new Option({ long: '--lines', valueKind: OperandKind.TEXT }),
  ],
  rest: new Operand({ kind: OperandKind.PATH }),
})

function numberLines(data: Uint8Array): Uint8Array {
  const text = DEC.decode(data)
  const lines = text.split('\n')
  const trailing = text.endsWith('\n')
  const limit = trailing ? lines.length - 1 : lines.length
  const out: string[] = []
  for (let i = 0; i < limit; i++) out.push(`     ${String(i + 1)}\t${lines[i] ?? ''}\n`)
  return ENC.encode(out.join(''))
}

async function catCommand(
  accessor: NowledgeMemAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const nFlag = opts.flags.n === true
  const p = paths[0]
  if (p !== undefined) {
    const path = nowledgeMemPath(p.original, p.prefix)
    const line =
      typeof opts.flags.line === 'string' ? Number.parseInt(opts.flags.line, 10) : undefined
    const lines =
      typeof opts.flags.lines === 'string' ? Number.parseInt(opts.flags.lines, 10) : undefined
    const data = await nowledgeMemRead(accessor, path, {
      ...(line !== undefined && Number.isFinite(line) ? { line } : {}),
      ...(lines !== undefined && Number.isFinite(lines) ? { lines } : {}),
    })
    const out: ByteSource = nFlag ? numberLines(data) : data
    return [out, new IOResult({ reads: { [p.stripPrefix]: data }, cache: [p.stripPrefix] })]
  }
  const raw = await readStdinAsync(opts.stdin)
  if (raw === null) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('cat: missing operand\n') })]
  }
  const out: ByteSource = nFlag ? numberLines(raw) : raw
  return [out, new IOResult()]
}

export const NOWLEDGE_MEM_CAT = command({
  name: 'cat',
  resource: ResourceName.NOWLEDGE_MEM,
  spec: SPEC,
  fn: catCommand,
})
