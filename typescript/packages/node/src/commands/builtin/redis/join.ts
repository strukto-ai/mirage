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

import {
  IOResult,
  ResourceName,
  command,
  materialize,
  specOf,
  type ByteSource,
  type CommandFnResult,
  type CommandOpts,
  type PathSpec,
} from '@struktoai/mirage-core'
import { stream as redisStream } from '../../../core/redis/stream.ts'
import type { RedisAccessor } from '../../../accessor/redis.ts'

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
      const rest = parts.slice(0, fieldIdx).concat(parts.slice(fieldIdx + 1))
      const list = result.get(key)
      if (list === undefined) result.set(key, [rest])
      else list.push(rest)
    }
  }
  return result
}

function formatRow(
  key: string,
  rest1: readonly string[],
  rest2: readonly string[],
  oFmt: string | null,
  outSep: string,
): string {
  if (oFmt === null) return [key, ...rest1, ...rest2].join(outSep)
  const fields: string[] = []
  for (const spec of oFmt.split(',')) {
    const trimmed = spec.trim()
    if (trimmed === '0') {
      fields.push(key)
    } else {
      const parts = trimmed.split('.')
      const fileN = Number.parseInt(parts[0] ?? '', 10)
      const fieldM = Number.parseInt(parts[1] ?? '', 10) - 1
      const src = fileN === 1 ? rest1 : rest2
      if (fieldM >= 0 && fieldM < src.length) fields.push(src[fieldM] ?? '')
      else fields.push('')
    }
  }
  return fields.join(outSep)
}

function firstValue<K, V>(map: Map<K, V>): V | undefined {
  for (const v of map.values()) return v
  return undefined
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
  const map1 = buildJoinMap(lines1, field1, sep)
  const map2 = buildJoinMap(lines2, field2, sep)
  const outSep = sep !== null && sep !== '' ? sep : ' '
  const outLines: string[] = []
  const matchedKeys2 = new Set<string>()

  for (const line of lines1) {
    const parts = splitFields(line, sep)
    if (field1 >= parts.length) continue
    const key = parts[field1] ?? ''
    const rest1 = parts.slice(0, field1).concat(parts.slice(field1 + 1))
    const hit = map2.get(key)
    if (hit !== undefined) {
      matchedKeys2.add(key)
      if (vFlag === null) {
        for (const rest2 of hit) {
          outLines.push(formatRow(key, rest1, rest2, oFlag, outSep))
        }
      }
    } else {
      if (vFlag === '1' || aFlag === '1') {
        let placeholder: string[] = []
        if (oFlag !== null && eFlag !== null && map2.size > 0) {
          const sample = firstValue(map2)?.[0]
          if (sample !== undefined) placeholder = sample.map(() => eFlag)
        }
        outLines.push(formatRow(key, rest1, placeholder, oFlag, outSep))
      }
    }
  }

  if (aFlag === '2' || vFlag === '2') {
    for (const line of lines2) {
      const parts = splitFields(line, sep)
      if (field2 >= parts.length) continue
      const key = parts[field2] ?? ''
      if (!matchedKeys2.has(key)) {
        const rest2 = parts.slice(0, field2).concat(parts.slice(field2 + 1))
        let placeholder: string[] = []
        if (oFlag !== null && eFlag !== null && map1.size > 0) {
          const sample = firstValue(map1)?.[0]
          if (sample !== undefined) placeholder = sample.map(() => eFlag)
        }
        outLines.push(formatRow(key, placeholder, rest2, oFlag, outSep))
      }
    }
  }

  return outLines
}

async function joinCommand(
  accessor: RedisAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
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
  const data1 = DEC.decode(await materialize(redisStream(accessor, p1)))
  const data2 = DEC.decode(await materialize(redisStream(accessor, p2)))
  const lines1 = splitLinesNoTrailing(data1)
  const lines2 = splitLinesNoTrailing(data2)
  const out = joinLines(lines1, lines2, field1, field2, sep, aFlag, vFlag, eFlag, oFlag)
  if (out.length === 0) return [null, new IOResult()]
  const result: ByteSource = ENC.encode(out.join('\n') + '\n')
  return [result, new IOResult()]
}

export const REDIS_JOIN = command({
  name: 'join',
  resource: ResourceName.REDIS,
  spec: specOf('join'),
  fn: joinCommand,
})
