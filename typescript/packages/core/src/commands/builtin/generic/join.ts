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

import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { extraOperandError } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function splitLinesNoTrailing(text: string): string[] {
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  return stripped === '' ? [] : stripped.split('\n')
}

function splitFields(line: string, delimiter: string | null): string[] {
  if (delimiter !== null && delimiter !== '') return line.split(delimiter)
  return line.split(/\s+/).filter((s) => s !== '')
}

function buildJoinMap(
  lines: readonly string[],
  fieldIdx: number,
  delimiter: string | null,
): Map<string, string[][]> {
  const result = new Map<string, string[][]>()
  for (const line of lines) {
    const parts = splitFields(line, delimiter)
    if (fieldIdx < parts.length) {
      const key = parts[fieldIdx] ?? ''
      const list = result.get(key)
      if (list === undefined) result.set(key, [parts])
      else list.push(parts)
    }
  }
  return result
}

function restFields(fields: readonly string[], keyIdx: number): string[] {
  return fields.slice(0, keyIdx).concat(fields.slice(keyIdx + 1))
}

function formatRow(
  key: string,
  fields1: readonly string[],
  field1: number,
  fields2: readonly string[],
  field2: number,
  oFmt: string | null,
  outSep: string,
  emptyValue: string | null,
): string {
  if (oFmt === null) {
    return [key, ...restFields(fields1, field1), ...restFields(fields2, field2)].join(outSep)
  }
  // -o FILENUM.FIELD indexes the original 1-based field (join key included),
  // so map against the full field list; a missing field uses the -e value.
  const fields: string[] = []
  for (const spec of oFmt.split(',')) {
    const trimmed = spec.trim()
    if (trimmed === '0') {
      fields.push(key)
      continue
    }
    const parts = trimmed.split('.')
    const src = parts[0] === '1' ? fields1 : fields2
    const idx = Number.parseInt(parts[1] ?? '', 10) - 1
    if (idx >= 0 && idx < src.length) fields.push(src[idx] ?? '')
    else fields.push(emptyValue ?? '')
  }
  return fields.join(outSep)
}

function joinLines(
  lines1: readonly string[],
  lines2: readonly string[],
  field1: number,
  field2: number,
  sep: string | null,
  aFlag: string | null,
  vFlag: string | null,
  eFlag: string | null,
  oFlag: string | null,
): string[] {
  const map2 = buildJoinMap(lines2, field2, sep)
  const outSep = sep !== null && sep !== '' ? sep : ' '
  const outLines: string[] = []
  const matchedKeys2 = new Set<string>()

  for (const line of lines1) {
    const parts = splitFields(line, sep)
    if (field1 >= parts.length) continue
    const key = parts[field1] ?? ''
    const hit = map2.get(key)
    if (hit !== undefined) {
      matchedKeys2.add(key)
      if (vFlag === null) {
        for (const fields2 of hit) {
          outLines.push(formatRow(key, parts, field1, fields2, field2, oFlag, outSep, eFlag))
        }
      }
    } else if (vFlag === '1' || aFlag === '1') {
      outLines.push(formatRow(key, parts, field1, [], field2, oFlag, outSep, eFlag))
    }
  }

  if (aFlag === '2' || vFlag === '2') {
    for (const line of lines2) {
      const parts = splitFields(line, sep)
      if (field2 >= parts.length) continue
      const key = parts[field2] ?? ''
      if (!matchedKeys2.has(key)) {
        outLines.push(formatRow(key, [], field1, parts, field2, oFlag, outSep, eFlag))
      }
    }
  }

  return outLines
}

export async function joinGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  if (paths.length > 2) throw extraOperandError(CommandName.JOIN, paths[2]?.rawPath ?? '')
  if (paths.length < 2) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('join: requires two paths\n') })]
  }
  const p1 = paths[0]
  const p2 = paths[1]
  if (p1 === undefined || p2 === undefined) return [null, new IOResult()]
  const field1 =
    (typeof opts.flags.args_1 === 'string' ? Number.parseInt(opts.flags.args_1, 10) : 1) - 1
  const field2 =
    (typeof opts.flags['2'] === 'string' ? Number.parseInt(opts.flags['2'], 10) : 1) - 1
  const sep = typeof opts.flags.t === 'string' ? opts.flags.t : null
  const aFlag = typeof opts.flags.a === 'string' ? opts.flags.a : null
  const vFlag = typeof opts.flags.v === 'string' ? opts.flags.v : null
  const eFlag = typeof opts.flags.e === 'string' ? opts.flags.e : null
  const oFlag = typeof opts.flags.o === 'string' ? opts.flags.o : null
  const data1 = DEC.decode(await materialize(stream(p1)))
  const data2 = DEC.decode(await materialize(stream(p2)))
  const lines1 = splitLinesNoTrailing(data1)
  const lines2 = splitLinesNoTrailing(data2)
  const out = joinLines(lines1, lines2, field1, field2, sep, aFlag, vFlag, eFlag, oFlag)
  if (out.length === 0) return [null, new IOResult()]
  const result: ByteSource = ENC.encode(out.join('\n') + '\n')
  return [result, new IOResult()]
}
