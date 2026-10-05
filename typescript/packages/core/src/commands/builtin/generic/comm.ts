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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { extraOperandError, missingOperandError } from '../../spec/usage.ts'
import { stdinStream } from '../utils/stream.ts'
import { CommandName, type FlagValue } from '../../spec/types.ts'
import { splitLines } from '../utils/lines.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

type MergeEntry = [number, string]

function commMerge(lines1: readonly string[], lines2: readonly string[]): MergeEntry[] {
  const result: MergeEntry[] = []
  let i = 0
  let j = 0
  while (i < lines1.length && j < lines2.length) {
    const a = lines1[i] ?? ''
    const b = lines2[j] ?? ''
    if (a < b) {
      result.push([1, a])
      i += 1
    } else if (a > b) {
      result.push([2, b])
      j += 1
    } else {
      result.push([3, a])
      i += 1
      j += 1
    }
  }
  while (i < lines1.length) {
    result.push([1, lines1[i] ?? ''])
    i += 1
  }
  while (j < lines2.length) {
    result.push([2, lines2[j] ?? ''])
    j += 1
  }
  return result
}

function formatComm(
  merged: readonly MergeEntry[],
  suppress1: boolean,
  suppress2: boolean,
  suppress3: boolean,
  delimiter: string,
  recordSeparator: string,
  total: boolean,
): string {
  const out: string[] = []
  const counts = [0, 0, 0]
  for (const [col, text] of merged) {
    counts[col - 1] = (counts[col - 1] ?? 0) + 1
    if (col === 1 && !suppress1) {
      out.push(text)
    } else if (col === 2 && !suppress2) {
      const prefix = suppress1 ? '' : delimiter
      out.push(prefix + text)
    } else if (col === 3 && !suppress3) {
      let prefix = ''
      if (!suppress1) prefix += delimiter
      if (!suppress2) prefix += delimiter
      out.push(prefix + text)
    }
  }
  if (total) {
    const visible = counts.filter((_count, index) => ![suppress1, suppress2, suppress3][index])
    out.push([...visible.map(String), 'total'].join(delimiter))
  }
  return out.length > 0 ? out.join(recordSeparator) + recordSeparator : ''
}

function isSorted(lines: readonly string[]): boolean {
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i - 1] ?? '') > (lines[i] ?? '')) return false
  }
  return true
}

interface CommFlags {
  readonly suppress1: boolean
  readonly suppress2: boolean
  readonly suppress3: boolean
  readonly checkOrder: boolean
  readonly outputDelimiter: string
  readonly total: boolean
  readonly zeroTerminated: boolean
}

function parseFlags(bag: Record<string, FlagValue>): CommFlags {
  const fl = new FlagView(bag, specOf('comm'))
  return {
    suppress1: fl.asBool('args_1'),
    suppress2: fl.asBool('2'),
    suppress3: fl.asBool('3'),
    checkOrder: fl.asBool('check_order'),
    outputDelimiter: fl.asStr('output_delimiter') ?? '\t',
    total: fl.asBool('total'),
    zeroTerminated: fl.asBool('zero_terminated'),
  }
}

export async function commGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  read: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const parsed = parseFlags(opts.flags)
  if (paths.length > 2) throw extraOperandError(CommandName.COMM, paths[2]?.rawPath ?? '')
  if (paths.length < 2) throw missingOperandError(CommandName.COMM, paths[0]?.rawPath ?? null)
  const p1 = paths[0]
  const p2 = paths[1]
  if (p1 === undefined || p2 === undefined) return [null, new IOResult()]
  const stream = stdinStream(read, opts.stdin)
  const data1 = DEC.decode(await materialize(stream(p1)))
  const data2 = DEC.decode(await materialize(stream(p2)))
  const zeroTerminated = parsed.zeroTerminated
  const lines1 = zeroTerminated ? data1.replace(/\0$/, '').split('\0') : splitLines(data1)
  const lines2 = zeroTerminated ? data2.replace(/\0$/, '').split('\0') : splitLines(data2)
  let stderr = ''
  if (parsed.checkOrder) {
    if (!isSorted(lines1)) stderr = 'comm: file 1 is not in sorted order\n'
    else if (!isSorted(lines2)) stderr = 'comm: file 2 is not in sorted order\n'
  }
  const merged = commMerge(lines1, lines2)
  const output = formatComm(
    merged,
    parsed.suppress1,
    parsed.suppress2,
    parsed.suppress3,
    parsed.outputDelimiter,
    zeroTerminated ? '\0' : '\n',
    parsed.total,
  )
  const result: ByteSource = ENC.encode(output)
  return [
    result,
    new IOResult({
      stderr: stderr !== '' ? ENC.encode(stderr) : null,
      exitCode: stderr !== '' ? 1 : 0,
    }),
  ]
}
