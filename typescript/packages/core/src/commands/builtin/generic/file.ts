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

import { IOResult, type ByteSource } from '../../../io/types.ts'
import { FileType, type FileStat, type PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { detectFileType, formatFileResult } from '../file_helper.ts'
import { formatRecords } from '../utils/output.ts'

const ENC = new TextEncoder()

export async function fileGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stat: (p: PathSpec) => Promise<FileStat>,
  read: (p: PathSpec) => Promise<Uint8Array>,
): Promise<CommandFnResult> {
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('file: missing operand\n') })]
  }
  const brief = opts.flags.b === true
  const mime = opts.flags.i === true
  const lines: string[] = []
  for (const p of paths) {
    const s = await stat(p)
    if (s.type === FileType.DIRECTORY) {
      lines.push(formatFileResult(p.virtual, FileType.DIRECTORY, brief, mime))
      continue
    }
    let header: Uint8Array
    try {
      const raw = await read(p)
      header = raw.subarray(0, 512)
    } catch {
      header = new Uint8Array(0)
    }
    const result = detectFileType(header, s)
    lines.push(formatFileResult(p.virtual, result, brief, mime))
  }
  const out: ByteSource = formatRecords(lines)
  return [out, new IOResult()]
}
