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
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { rstripSlash } from '../../../utils/slash.ts'

const ENC = new TextEncoder()

function normalize(p: string, cwd: string): string {
  const path = p.startsWith('/') ? p : `${rstripSlash(cwd)}/${p}`
  const parts = path.split('/').filter((s) => s !== '' && s !== '.')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

async function pathExists(stat: (p: PathSpec) => Promise<unknown>, p: PathSpec): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export async function realpathGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stat: (p: PathSpec) => Promise<unknown>,
): Promise<CommandFnResult> {
  const requireExists = opts.flags.e === true
  const lines: string[] = []
  if (paths.length > 0) {
    for (const p of paths) {
      if (requireExists && !(await pathExists(stat, p))) {
        throw new Error(`realpath: '${p.virtual}': No such file or directory`)
      }
      lines.push(normalize(p.virtual, opts.cwd))
    }
  } else {
    for (const t of texts) lines.push(normalize(t, opts.cwd))
  }
  const out: ByteSource = ENC.encode(lines.join('\n') + '\n')
  return [out, new IOResult()]
}
