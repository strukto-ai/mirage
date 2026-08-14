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
import { FlagView } from '../../spec/types.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { FileType, type FileStat, type PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { detectFileType, formatFileResult } from '../file_helper.ts'
import { MIME_SYMLINK } from '../constants.ts'
import { LINK_TARGET_KEY } from '../../../types.ts'
import type { LinkView } from '../../../ops/types.ts'
import { CycleError } from '../../../utils/path.ts'
import { formatRecords } from '../utils/output.ts'

const ENC = new TextEncoder()

// How `file` describes a symlink operand, or null if it is not one.
//
// GNU names the target verbatim as it was stored, and calls the link
// broken when the target does not resolve to anything. A cycle counts
// as broken: nothing is reachable through it either.
async function linkDescription(path: PathSpec, links: LinkView): Promise<string | null> {
  const row = links.statAt(path.virtual)
  if (row === null) return null
  const target = typeof row.extra[LINK_TARGET_KEY] === 'string' ? row.extra[LINK_TARGET_KEY] : ''
  let resolved: string
  try {
    resolved = links.resolve(path.virtual)
  } catch (err) {
    if (!(err instanceof CycleError)) throw err
    return `broken symbolic link to ${target}`
  }
  if (!(await links.exists(resolved))) return `broken symbolic link to ${target}`
  return `symbolic link to ${target}`
}

export async function fileGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stat: (p: PathSpec) => Promise<FileStat>,
  read: (p: PathSpec) => Promise<Uint8Array>,
): Promise<CommandFnResult> {
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('file: missing operand\n') })]
  }
  const fl = new FlagView(opts.flags, specOf('file'))
  const brief = fl.asBool('b')
  const mime = fl.asBool('i')
  // GNU always names the operand exactly as typed, never a resolved or
  // absolutised form, so every row is labelled with rawPath.
  const lines: string[] = []
  // Without -L the operand arrives unfollowed, so a link is described
  // as a link rather than sniffed as its target.
  const links = opts.ns?.links ?? null
  for (const p of paths) {
    if (links !== null) {
      const described = await linkDescription(p, links)
      if (described !== null) {
        lines.push(formatFileResult(p.rawPath, mime ? MIME_SYMLINK : described, brief, false))
        continue
      }
    }
    const s = await stat(p)
    if (s.type === FileType.DIRECTORY) {
      lines.push(formatFileResult(p.rawPath, FileType.DIRECTORY, brief, mime))
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
    lines.push(formatFileResult(p.rawPath, result, brief, mime))
  }
  const out: ByteSource = formatRecords(lines)
  return [out, new IOResult()]
}
