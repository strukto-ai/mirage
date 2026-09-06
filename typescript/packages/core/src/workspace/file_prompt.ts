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

import { patternMatches } from '../policy/match/pattern.ts'
import { skillFor } from '../commands/cli/skill.ts'
import { SHOPT_DEFAULTS } from '../shell/constants.ts'
import { MountMode } from '../types.ts'
import type { MountEntry } from './mount/mount.ts'
import { rstripSlash } from '../utils/slash.ts'
import { compareCodePoints } from '../utils/sort.ts'
import type { CLIInstall } from './cli/types.ts'
import type { Session } from './session/session.ts'
import { cliTreeVisible, verbVisible } from './lookup/lookup.ts'

const HELP_HINT =
  'Tip: run `man` to list every available command grouped by resource, `man <cmd>` for a single entry, and `<cmd> --help` for flag details.'

const CLIS_HEADER =
  'Installed CLIs (choose the intended account; mounts and CLI installs are independent):'

/** A description ending in a full stop, without doubling one already there. */
function terminated(description: string): string {
  return description.endsWith('.') ? description : `${description}.`
}

/** Match the whole help line, not just a visible head-word prefix. */
function helpAllowed(tokens: readonly string[], session: Session): boolean {
  const expandAliases =
    session.shopts.expand_aliases ?? SHOPT_DEFAULTS.get('expand_aliases') ?? false
  if (expandAliases && tokens[0] !== undefined && Object.hasOwn(session.aliases, tokens[0]))
    return false
  const allow = session.commands?.allow
  return allow == null || allow.some((pattern) => patternMatches(pattern, tokens))
}

/**
 * The CLIs section: one row per install, sorted by head word. A skilled
 * CLI's row carries its skill's frontmatter description (the same text
 * the system prompt should show without loading the whole skill body);
 * an unskilled one falls back to its spec's own description.
 */
function renderCliSection(clis: ReadonlyMap<string, CLIInstall>, session: Session | null): string {
  if (session === null) return ''
  const lines = [CLIS_HEADER]
  const heads = [...clis.keys()].sort(compareCodePoints)
  for (const head of heads) {
    const install = clis.get(head)
    if (install === undefined || !verbVisible(head, [], session)) continue
    const skill = skillFor(install.spec, head)
    const fullTree = cliTreeVisible(head, install.spec, session)
    const description = fullTree
      ? skill !== null
        ? skill.description
        : (install.spec.description ?? '(no description)')
      : 'CLI with a restricted command set'
    const guide = helpAllowed(['man', head], session)
      ? ` Guide: man ${head}`
      : fullTree &&
          !Object.hasOwn(session.functions, head) &&
          helpAllowed([head, '--help'], session)
        ? ` Guide: ${head} --help`
        : ''
    lines.push(`- ${head} — ${terminated(description)}${guide}`)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

export function buildFilePrompt(
  mounts: readonly MountEntry[],
  clis: ReadonlyMap<string, CLIInstall>,
  session: Session | null,
): string {
  const parts: string[] = []
  if (session !== null)
    parts.push(
      helpAllowed(['man'], session) ? HELP_HINT : 'Tip: run `<cmd> --help` for flag details.',
    )
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
  const cliSection = renderCliSection(clis, session)
  if (cliSection !== '') parts.push(cliSection)
  return parts.join('\n\n')
}
