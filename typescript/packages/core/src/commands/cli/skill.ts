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

import type { CLISpec, Skill } from './types.ts'
import { SKILLED_CLIS } from './constants.ts'
import { SKILLS } from './generated/skills_data.ts'
import { builtinSpecFor } from './specs.ts'

const FRONTMATTER_DELIM = '---'

/** Strip one layer of matching single or double quotes, if present. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/**
 * Parse a SKILL.md's frontmatter and body. No yaml dependency: this reads
 * only top-level `key: value` scalar lines, which is all an agentskills.io
 * SKILL.md needs (`name` and `description`); nested and indented lines are
 * ignored. Throws when the frontmatter is missing/unterminated or `name`/
 * `description` is absent or empty, since a skill without those cannot be
 * looked up or shown to a host.
 */
export function parseSkill(text: string): Skill {
  if (!text.startsWith(`${FRONTMATTER_DELIM}\n`)) {
    throw new Error('SKILL.md must start with a --- frontmatter block')
  }
  const lines = text.split('\n')
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FRONTMATTER_DELIM) {
      end = i
      break
    }
  }
  if (end === -1) {
    throw new Error('SKILL.md frontmatter is not terminated with a closing ---')
  }
  let name: string | null = null
  let description: string | null = null
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (match === null) continue
    const [, key, rawValue] = match
    if (key === undefined || rawValue === undefined) continue
    const value = unquote(rawValue.trim())
    if (key === 'name') name = value
    if (key === 'description') description = value
  }
  if (name === null || name === '') {
    throw new Error('SKILL.md frontmatter must declare a non-empty name')
  }
  if (description === null || description === '') {
    throw new Error('SKILL.md frontmatter must declare a non-empty description')
  }
  const body = lines
    .slice(end + 1)
    .join('\n')
    .trim()
  return { name, description, body, text }
}

/**
 * `text` with every mention of the program `name` spelled `head`. A mention
 * is the bare word: not a piece of a longer identifier, a path segment or a
 * dotted name, so `ntn` in `ntn-prod`, `/ntn` or `foo.ntn` is left alone.
 * Every skill names its program only in the lowercase head word (the
 * product is capitalized in prose), which is what makes a plain word match
 * safe.
 */
function respell(text: string, name: string, head: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(^|[^\\w/.-])${escaped}(?![\\w-])`, 'gm')
  return text.replace(pattern, (_match, before: string) => `${before}${head}`)
}

/**
 * The skill for a bundled CLI spec, null when it ships none. Bound to the
 * builtin tree itself, so a custom tree with the same name cannot inherit
 * an unrelated guide. Two installs of one builtin still share one skill.
 * Only SKILLED_CLIS answer: the generated map also carries the
 * plugin's own skills (`mirage-filesystem`), and a user spec that happens to
 * share such a name must not inherit one.
 *
 * A skill is written for the program's own name, and an install may answer
 * to another word (`ntn-prod` beside `ntn`). Given that `head`, the
 * description and body are respelled for it, so the lines the manual teaches
 * are the lines this install runs and not another account's; `name` and
 * `text` stay the file's.
 */
export function skillFor(spec: CLISpec, head?: string): Skill | null {
  const name = spec.name
  if (!SKILLED_CLIS.has(name) || builtinSpecFor(name) !== spec) return null
  const text = SKILLS[name]
  if (text === undefined) return null
  const skill = parseSkill(text)
  if (head === undefined || head === skill.name) return skill
  return {
    ...skill,
    description: respell(skill.description, skill.name, head),
    body: respell(skill.body, skill.name, head),
  }
}
