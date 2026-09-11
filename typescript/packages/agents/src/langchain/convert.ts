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

import type { ExecuteResponse, FileInfo, GrepMatch } from 'deepagents'
import type { Refusal } from '@struktoai/mirage-core/types'
import { withRefusal } from '../io-text.ts'

interface IOLike {
  stdoutText: string
  stderrText: string
  exitCode: number | null
  refusal?: Refusal | null
}

export function ioToExecuteResponse(io: IOLike): ExecuteResponse {
  const stdout = io.stdoutText
  const stderr = io.stderrText
  let output = stdout
  if (stderr.length > 0) {
    output = stdout.length > 0 ? `${stdout}\n${stderr}` : stderr
  }
  return {
    output: withRefusal(output, io.refusal ?? null),
    exitCode: io.exitCode,
    truncated: false,
  }
}

export function ioToGrepMatches(io: IOLike): GrepMatch[] {
  const stdout = io.stdoutText.trim()
  if (stdout.length === 0) return []
  const matches: GrepMatch[] = []
  for (const line of stdout.split('\n')) {
    const firstColon = line.indexOf(':')
    if (firstColon < 0) continue
    const secondColon = line.indexOf(':', firstColon + 1)
    if (secondColon < 0) continue
    const path = line.slice(0, firstColon)
    const lineNumStr = line.slice(firstColon + 1, secondColon)
    const text = line.slice(secondColon + 1)
    const lineNum = Number.parseInt(lineNumStr, 10)
    if (Number.isNaN(lineNum)) continue
    matches.push({ path, line: lineNum, text })
  }
  return matches
}

export function ioToFileInfos(io: IOLike): FileInfo[] {
  const stdout = io.stdoutText.trim()
  if (stdout.length === 0) return []
  const infos: FileInfo[] = []
  for (const raw of stdout.split('\n')) {
    const entry = raw.trim()
    if (entry.length === 0) continue
    const isDir = entry.endsWith('/')
    infos.push({ path: isDir ? entry.slice(0, -1) : entry, is_dir: isDir })
  }
  return infos
}
