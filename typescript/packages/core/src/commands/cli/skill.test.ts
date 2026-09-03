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

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SKILLED_CLIS } from './constants.ts'
import { SKILLS } from './generated/skills_data.ts'
import { parseSkill, skillFor } from './skill.ts'
import { walk } from './walk.ts'
import { parseSpecFor } from '../../workspace/executor/command/cli.ts'
import { optionError, parseFlags } from '../../workspace/executor/command/flags.ts'
import { DISCORD } from './builtin/discord/index.ts'
import { GWS } from './builtin/gws/index.ts'
import { LINEAR } from './builtin/linear/index.ts'
import { NTN } from './builtin/ntn/index.ts'
import { SLACK } from './builtin/slack/index.ts'
import type { CLISpec } from './types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '../../../../../..')
const SKILLS_DIR = join(REPO_ROOT, 'plugins/mirage/skills')

const CLI_SPECS: Readonly<Record<string, CLISpec>> = {
  discord: DISCORD,
  gws: GWS,
  linear: LINEAR,
  ntn: NTN,
  slack: SLACK,
}

/**
 * A small POSIX-ish tokenizer: single/double-quoted spans hold literal
 * text (with `\"`, `\\`, `\$`, `` \` `` recognized inside double quotes),
 * unquoted backslash escapes the next character, whitespace splits
 * words, and an unquoted `|` ends the line (shell-style pipe cut) since
 * only the part before it is one command's argv.
 */
function splitWords(line: string): string[] {
  const words: string[] = []
  let current = ''
  let hasContent = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i)
    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null
      } else if (ch === '\\' && i + 1 < line.length && '"\\$`'.includes(line.charAt(i + 1))) {
        current += line.charAt(++i)
      } else {
        current += ch
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      hasContent = true
      continue
    }
    if (ch === '\\' && i + 1 < line.length) {
      current += line.charAt(++i)
      hasContent = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (hasContent) {
        words.push(current)
        current = ''
        hasContent = false
      }
      continue
    }
    if (ch === '|') break
    current += ch
    hasContent = true
  }
  if (hasContent) words.push(current)
  return words
}

/** Every line inside a ```bash fence of a skill body that starts with `<cli> `. */
function bashInvocations(body: string, cli: string): string[] {
  const lines: string[] = []
  let inBashFence = false
  for (const raw of body.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed.startsWith('```')) {
      inBashFence = !inBashFence && trimmed === '```bash'
      continue
    }
    if (inBashFence && trimmed.startsWith(`${cli} `)) lines.push(trimmed)
  }
  return lines
}

describe('parseSkill', () => {
  it('reads name, description and trims the body', () => {
    const text = [
      '---',
      'name: demo',
      'description: A demo skill.',
      '---',
      '',
      '# Demo',
      '',
      'Body text.',
      '',
    ].join('\n')
    const skill = parseSkill(text)
    expect(skill.name).toBe('demo')
    expect(skill.description).toBe('A demo skill.')
    expect(skill.body).toBe('# Demo\n\nBody text.')
    expect(skill.text).toBe(text)
  })

  it('strips matching surrounding quotes from scalar values', () => {
    const withDouble = [
      '---',
      'name: "demo"',
      'description: "Quoted description."',
      '---',
      '',
    ].join('\n')
    expect(parseSkill(withDouble).name).toBe('demo')
    expect(parseSkill(withDouble).description).toBe('Quoted description.')

    const withSingle = ['---', "name: 'demo'", "description: 'Single quoted.'", '---', ''].join(
      '\n',
    )
    expect(parseSkill(withSingle).name).toBe('demo')
    expect(parseSkill(withSingle).description).toBe('Single quoted.')
  })

  it('ignores nested and indented lines', () => {
    const text = [
      '---',
      'name: demo',
      'description: Has metadata.',
      'metadata:',
      '  nested: value',
      'tags: [a, b]',
      '---',
      '',
      'Body.',
      '',
    ].join('\n')
    const skill = parseSkill(text)
    expect(skill.name).toBe('demo')
    expect(skill.description).toBe('Has metadata.')
  })

  it('throws when the frontmatter is missing', () => {
    expect(() => parseSkill('# No frontmatter\n')).toThrow()
  })

  it('throws when the frontmatter is unterminated', () => {
    expect(() => parseSkill('---\nname: demo\ndescription: d\n')).toThrow()
  })

  it('throws when name is absent', () => {
    expect(() => parseSkill('---\ndescription: d\n---\nBody\n')).toThrow()
  })

  it('throws when description is absent', () => {
    expect(() => parseSkill('---\nname: demo\n---\nBody\n')).toThrow()
  })

  it('throws when name is empty', () => {
    expect(() => parseSkill('---\nname: \ndescription: d\n---\nBody\n')).toThrow()
  })

  it('throws when description is empty', () => {
    expect(() => parseSkill('---\nname: demo\ndescription: \n---\nBody\n')).toThrow()
  })
})

describe('skillFor', () => {
  it('returns null for a CLI with no skill', () => {
    expect(skillFor('git')).toBeNull()
  })

  it('returns null for an unregistered name', () => {
    expect(skillFor('no-such-cli')).toBeNull()
  })

  it('ignores a plugin skill that is not a CLI', () => {
    // The generated map carries the plugin's own skill too; a user spec
    // named after it must not inherit unrelated instructions.
    expect(SKILLS['mirage-filesystem']).toBeDefined()
    expect(skillFor('mirage-filesystem')).toBeNull()
  })
})

describe('generated skills_data is in sync with plugins/mirage/skills', () => {
  const dirs = readdirSync(SKILLS_DIR).filter((name) =>
    statSync(join(SKILLS_DIR, name)).isDirectory(),
  )

  it('has a directory for every generated key and vice versa', () => {
    expect(new Set(Object.keys(SKILLS))).toEqual(new Set(dirs))
  })

  for (const name of dirs) {
    it(`SKILLS['${name}'] matches the file on disk`, () => {
      const text = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf-8')
      expect(SKILLS[name]).toBe(text)
    })
  }
})

describe('SKILLED_CLIS', () => {
  for (const name of SKILLED_CLIS) {
    it(`'${name}' ships a skill whose frontmatter matches`, () => {
      const skill = skillFor(name)
      expect(skill).not.toBeNull()
      if (skill === null) return
      expect(skill.name).toBe(name)
      expect(skill.description.length).toBeLessThanOrEqual(1024)
    })
  }

  it('git is not a skilled CLI', () => {
    expect(SKILLED_CLIS.has('git')).toBe(false)
    expect(skillFor('git')).toBeNull()
  })
})

describe('skill bash examples dry-parse', () => {
  for (const name of SKILLED_CLIS) {
    const spec = CLI_SPECS[name]
    if (spec === undefined) {
      throw new Error(`add '${name}' to CLI_SPECS in skill.test.ts`)
    }
    const skill = skillFor(name)
    if (skill === null) {
      it(`'${name}' skill body dry-parses`, () => {
        throw new Error(`no skill for '${name}'; add plugins/mirage/skills/${name}/SKILL.md`)
      })
      continue
    }
    const invocations = bashInvocations(skill.body, name)
    for (const line of invocations) {
      it(`dry-parses: ${line}`, () => {
        const words = splitWords(line)
        const argv = words.slice(1)
        const result = walk(name, spec, argv, '/', {})
        if (result.leaf === null) {
          const decoded = new TextDecoder().decode(result.output)
          throw new Error(`'${line}' did not resolve to a leaf:\n${decoded}`)
        }
        const [parseSpec] = parseSpecFor(result.leaf)
        const prog = [name, ...result.path].join(' ')
        const parsed = parseFlags([...result.argv], parseSpec, prog, '/', {})
        const refusal = optionError(prog, parsed)
        expect(refusal, `'${line}' was refused`).toBeNull()
      })
    }
  }
})
