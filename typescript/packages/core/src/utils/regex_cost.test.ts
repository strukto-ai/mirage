import { describe, expect, it } from 'vitest'
import { LOOP_BUDGET } from '../concurrency/constants.ts'
import { loopLimit } from './regex_cost.ts'

describe('loopLimit', () => {
  it.each(['(a+)+$', '(?:a*)*b', '(?:a|b)+', '(a)\\1', '(?<x>a)\\k<x>', '(?=.*x)'])(
    'never runs %s in place',
    (source) => {
      expect(loopLimit(new RegExp(source))).toBe(-1)
    },
  )

  it.each([
    [/needle/, /[0-9]*/, /\bdef \w+\(/],
    [/TODO|FIXME/, /x.*y/, /a*a*b/],
    [/(?<![0-9A-Z_a-z])(?:a)(?![0-9A-Z_a-z])/, /(?:ab)+/, /a*a*b/],
  ])('runs shorter subjects in place as %s branches more', (pattern, shorter, longer) => {
    const limits = [pattern, shorter, longer].map(loopLimit)
    expect(limits[0]).toBeGreaterThan(limits[1] ?? 0)
    expect(limits[1]).toBeGreaterThan(limits[2] ?? 0)
    expect(limits[2]).toBeGreaterThan(0)
  })

  it('runs any line of an anchored literal in place', () => {
    expect(loopLimit(/^unique_history_1221$/)).toBeGreaterThan(900_000)
    expect(loopLimit(/^a|b/)).toBeLessThan(loopLimit(/^ab/))
    expect(loopLimit(/^ab/m)).toBeLessThan(loopLimit(/^ab/))
  })

  it('reads an empty class and a nested set as one character', () => {
    expect(loopLimit(new RegExp('[]a'))).toBe(loopLimit(/[x]a/))
    expect(loopLimit(new RegExp('[[a-z]--[aeiou]]x', 'v'))).toBe(loopLimit(/[x]x/))
  })

  it('reads a literal brace as one character', () => {
    expect(loopLimit(/a{x}/)).toBe(loopLimit(/a[{]x}/))
  })

  it('counts the work inside each count of a repeat', () => {
    expect(loopLimit(new RegExp('^(?:(?=a{60000})a)*b'))).toBeLessThan(10)
    expect(loopLimit(/(?:(?=a{9})a)*b/)).toBeLessThan(loopLimit(/(?:a)*b/))
  })

  it('never exceeds the budget', () => {
    expect(loopLimit(/(?:)/)).toBeLessThanOrEqual(LOOP_BUDGET)
  })
})
