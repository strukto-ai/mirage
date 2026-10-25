import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { WordKind } from '../../commands/spec/types.ts'
import { MountMode, PathSpec, type Visibility } from '../../types.ts'
import {
  classifyPaths,
  classifyShows,
  classifyVars,
  hiddenUnder,
  hideDepth,
  moveReveals,
  pathVisible,
  showDepth,
  shownMode,
  varHidden,
} from '../../utils/hidden.ts'
import { CommandWord } from '../types.ts'
import { decide } from './decide.ts'
import { patternMatches, patternReaches, splitPattern } from './pattern.ts'

const rule = z.object({
  reason: z.string(),
  commands: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
  mount: z.string().default(''),
})
const mode = z.enum([MountMode.READ, MountMode.WRITE, MountMode.EXEC])
const corpus = z
  .object({
    patterns: z.array(
      z.object({
        pattern: z.string(),
        tokens: z.array(z.string()),
        split: z.array(z.string()),
        matches: z.boolean(),
        reaches: z.boolean(),
      }),
    ),
    visibility: z.array(
      z.object({
        hide: z.array(z.string()),
        show: z.array(z.object({ path: z.string(), mode: mode.nullable() })),
        vars: z.array(z.string()),
        queries: z.array(
          z.object({
            path: z.string(),
            visible: z.boolean(),
            hide_depth: z.number().nullable(),
            show_depth: z.number().nullable(),
            mode: z.tuple([z.number(), mode]).nullable(),
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
        rules: z.object({
          allow: z.array(z.string()).nullable(),
          deny: z.array(rule),
          ask: z.array(rule),
        }),
        facts: z.object({
          command: z.string(),
          tokens: z.array(z.string()),
          cwd: z.string(),
          tool: z.boolean(),
          paths: z.array(z.string()),
          operands: z.array(z.string()),
          walks: z.boolean(),
        }),
        expected: z.object({
          outcome: z.string(),
          rule: z.number().nullable(),
          matched_path: z.string().nullable(),
          source: z.string(),
          asks: z.array(z.number()),
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
  it.each(corpus.patterns)('preserves prefix pattern $pattern for $tokens', (row) => {
    expect(splitPattern(row.pattern)).toEqual(row.split)
    expect(patternMatches(row.pattern, row.tokens)).toBe(row.matches)
    expect(patternReaches(row.pattern, row.tokens)).toBe(row.reaches)
  })
  it.each(corpus.visibility)('preserves visibility for $hide', (row) => {
    const visibility: Visibility = {
      paths: classifyPaths(row.hide),
      shown: classifyShows(row.show),
      vars: classifyVars(row.vars),
      processes: 'session',
    }
    for (const query of row.queries) {
      expect(pathVisible(visibility, query.path)).toBe(query.visible)
      expect(hideDepth(visibility.paths, query.path)).toBe(query.hide_depth)
      expect(showDepth(visibility.shown, query.path)).toBe(query.show_depth)
      expect(shownMode(visibility.shown, query.path)).toEqual(query.mode)
      expect(hiddenUnder(visibility, query.path)).toBe(query.hidden_under)
    }
    for (const move of row.moves)
      expect(moveReveals(visibility, move.src, move.dst)).toBe(move.reveals)
    for (const variable of row.variables)
      expect(varHidden(visibility, variable.name)).toBe(variable.hidden)
  })
  it.each(corpus.admissions)('preserves $name and winning original rule objects', (row) => {
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
        words: operands.map((p) => new CommandWord(p.virtual, WordKind.OPERAND, null, p)),
      },
      row.rules,
    )
    const rules = [...row.rules.deny, ...row.rules.ask]
    expect(ruling.outcome).toBe(row.expected.outcome)
    expect(ruling.rule).toBe(row.expected.rule === null ? null : rules[row.expected.rule])
    expect(ruling.matchedPath).toBe(row.expected.matched_path)
    expect(ruling.source).toBe(row.expected.source)
    expect(ruling.asks).toEqual(row.expected.asks.map((id) => rules[id]))
    row.expected.asks.forEach((id, index) => {
      expect(ruling.asks[index]).toBe(rules[id])
    })
  })
})
