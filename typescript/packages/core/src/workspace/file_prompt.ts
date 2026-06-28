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

import { MountMode } from '../types.ts'
import type { MountEntry } from './mount/mount.ts'
import { rstripSlash } from '../utils/slash.ts'

const HELP_HINT =
  'Tip: run `man` to list every available command grouped by resource, `man <cmd>` for a single entry, and `<cmd> --help` for flag details.'

export function buildFilePrompt(mounts: readonly MountEntry[]): string {
  const parts: string[] = [HELP_HINT]
  for (const m of mounts) {
    const r = m.resource as { prompt?: string; writePrompt?: string }
    const prompt = r.prompt
    if (prompt === undefined || prompt === '') continue
    const prefix = rstripSlash(m.prefix) || '/'
    let section = prompt.replace(/\{prefix\}/g, prefix)
    if (m.mode !== MountMode.READ && r.writePrompt !== undefined && r.writePrompt !== '') {
      section += '\n' + r.writePrompt.replace(/\{prefix\}/g, prefix)
    }
    parts.push(section)
  }
  return parts.join('\n\n')
}
