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
import { stream as diskStream } from '../../../core/disk/stream.ts'
import type { DiskAccessor } from '../../../accessor/disk.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function splitLinesNoTrailing(text: string): string[] {
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  return stripped === '' ? [] : stripped.split('\n')
}

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
): string {
  const out: string[] = []
  for (const [col, text] of merged) {
    if (col === 1 && !suppress1) {
      out.push(text)
    } else if (col === 2 && !suppress2) {
      const prefix = suppress1 ? '' : '\t'
      out.push(prefix + text)
    } else if (col === 3 && !suppress3) {
      let prefix = ''
      if (!suppress1) prefix += '\t'
      if (!suppress2) prefix += '\t'
      out.push(prefix + text)
    }
  }
  return out.length > 0 ? out.join('\n') + '\n' : ''
}

function isSorted(lines: readonly string[]): boolean {
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i - 1] ?? '') > (lines[i] ?? '')) return false
  }
  return true
}

async function commCommand(
  accessor: DiskAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  if (paths.length < 2) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('comm: requires two paths\n') })]
  }
  const p1 = paths[0]
  const p2 = paths[1]
  if (p1 === undefined || p2 === undefined) return [null, new IOResult()]
  const data1 = DEC.decode(await materialize(diskStream(accessor, p1)))
  const data2 = DEC.decode(await materialize(diskStream(accessor, p2)))
  const lines1 = splitLinesNoTrailing(data1)
  const lines2 = splitLinesNoTrailing(data2)
  let stderr = ''
  if (opts.flags['check-order'] === true) {
    if (!isSorted(lines1)) stderr = 'comm: file 1 is not in sorted order\n'
    else if (!isSorted(lines2)) stderr = 'comm: file 2 is not in sorted order\n'
  }
  const suppress1 = opts.flags.args_1 === true
  const suppress2 = opts.flags['2'] === true
  const suppress3 = opts.flags['3'] === true
  const merged = commMerge(lines1, lines2)
  const output = formatComm(merged, suppress1, suppress2, suppress3)
  const result: ByteSource = ENC.encode(output)
  return [result, new IOResult({ stderr: stderr !== '' ? ENC.encode(stderr) : null })]
}

export const DISK_COMM = command({
  name: 'comm',
  resource: ResourceName.DISK,
  spec: specOf('comm'),
  fn: commCommand,
})
