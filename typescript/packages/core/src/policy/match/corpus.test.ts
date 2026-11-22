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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { WordKind } from '../../commands/spec/types.ts'
import { MountMode, PathSpec, type Visibility } from '../../types.ts'
import {
  classifyPaths,
  hiddenUnder,
  isGlob,
  moveReveals,
  pathVisible,
  varHidden,
} from '../../utils/hidden.ts'
import { commandTree } from '../profile.ts'
import { CommandWord } from '../types.ts'
import { decide } from './decide.ts'

const mode = z.enum([MountMode.READ, MountMode.WRITE, MountMode.EXEC])
const corpus = z
  .object({
    visibility: z.array(
      z.object({
        hide: z.array(z.string()),
        show: z.array(z.object({ path: z.string(), mode: mode.nullable() })),
        vars: z.array(z.string()),
        queries: z.array(
          z.object({
            path: z.string(),
            visible: z.boolean(),
            hidden_under: z.boolean(),
          }),
        ),
        moves: z.array(z.object({ src: z.string(), dst: z.string(), reveals: z.boolean() })),
        variables: z.array(z.object({ name: z.string(), hidden: z.boolean() })),
      }),
    ),
    admissions: z.array(
      z.object({
        name: z.string(),
        trees: z.array(
          z.object({ mount: z.string().nullable(), commands: z.record(z.string(), z.unknown()) }),
        ),
        facts: z.object({
          command: z.string(),
          tokens: z.array(z.string()),
          cwd: z.string(),
          tool: z.boolean(),
          paths: z.array(z.string()),
          operands: z.array(z.string()),
          walks: z.boolean(),
          walks_into: z.array(z.string()).default([]),
          subtree: z.boolean(),
        }),
        expected: z.object({
          outcome: z.string(),
          at: z.string().nullable(),
          source: z.string(),
          asks: z.array(z.string()),
        }),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL('../../../../../../integ/policy/matching.json', import.meta.url),
        'utf8',
      ),
    ),
  )

function path(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
    vfsPath: virtual,
    rawPath: virtual,
  })
}

describe('shared policy compatibility cases', () => {
  it.each(corpus.visibility)('preserves visibility for $hide', (row) => {
    const visibility: Visibility = {
      paths: classifyPaths(row.hide),
      shown: row.show.length === 0 ? null : { entries: row.show },
      vars: {
        names: row.vars.filter((name) => !isGlob(name)),
        patterns: row.vars.filter((name) => isGlob(name)),
      },
      processes: 'session',
    }
    for (const query of row.queries) {
      expect(pathVisible(visibility, query.path)).toBe(query.visible)
      expect(hiddenUnder(visibility, query.path)).toBe(query.hidden_under)
    }
    for (const move of row.moves)
      expect(moveReveals(visibility, move.src, move.dst)).toBe(move.reveals)
    for (const variable of row.variables)
      expect(varHidden(visibility, variable.name)).toBe(variable.hidden)
  })
  it.each(corpus.admissions)('preserves $name and the leaf that decides', (row) => {
    const facts = row.facts,
      paths = facts.paths.map(path),
      operands = facts.operands.map(path)
    const ruling = decide(
      {
        command: facts.command,
        tokens: facts.tokens,
        argv: facts.tokens.slice(1),
        cwd: facts.cwd,
        tool: facts.tool,
        paths,
        walks: facts.walks,
        walksInto: facts.walks_into,
        subtree: facts.subtree,
        words: operands.map((p) => new CommandWord(p.virtual, WordKind.OPERAND, null, p)),
      },
      {
        trees: row.trees.map((tree) => ({
          tree: commandTree(tree.commands),
          mount: tree.mount ?? '',
          inline: false,
        })),
      },
    )
    expect(ruling.outcome).toBe(row.expected.outcome)
    expect(ruling.rule?.at ?? null).toBe(row.expected.at)
    expect(ruling.source).toBe(row.expected.source)
    expect(ruling.asks.map((a) => a.at)).toEqual(row.expected.asks)
  })
})
