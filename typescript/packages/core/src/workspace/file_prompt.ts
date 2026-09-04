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

import { skillFor } from '../commands/cli/skill.ts'
import { MountMode } from '../types.ts'
import type { MountEntry } from './mount/mount.ts'
import { rstripSlash } from '../utils/slash.ts'
import { compareCodePoints } from '../utils/sort.ts'
import type { CLIInstall } from './cli/types.ts'

const HELP_HINT =
  'Tip: run `man` to list every available command grouped by resource, `man <cmd>` for a single entry, and `<cmd> --help` for flag details.'

const CLIS_HEADER =
  'Installed CLIs (act on a service by name; the mounts above are how you find its ids):'

/** A description ending in a full stop, without doubling one already there. */
function terminated(description: string): string {
  return description.endsWith('.') ? description : `${description}.`
}

/**
 * The CLIs section: one row per install, sorted by head word. A skilled
 * CLI's row carries its skill's frontmatter description (the same text
 * the system prompt should show without loading the whole skill body);
 * an unskilled one falls back to its spec's own description.
 */
function renderCliSection(clis: ReadonlyMap<string, CLIInstall>): string {
  const lines = [CLIS_HEADER]
  const heads = [...clis.keys()].sort(compareCodePoints)
  for (const head of heads) {
    const install = clis.get(head)
    if (install === undefined) continue
    const skill = skillFor(install.spec.name, head)
    const description =
      skill !== null ? skill.description : (install.spec.description ?? '(no description)')
    lines.push(`- ${head} — ${terminated(description)} Guide: man ${head}`)
  }
  return lines.join('\n')
}

export function buildFilePrompt(
  mounts: readonly MountEntry[],
  clis: ReadonlyMap<string, CLIInstall>,
): string {
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
  if (clis.size > 0) parts.push(renderCliSection(clis))
  return parts.join('\n\n')
}
