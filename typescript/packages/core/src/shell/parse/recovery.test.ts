import { beforeAll, describe, expect, it } from 'vitest'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { getParts, getRedirects, getText } from '../helpers.ts'
import type { TSNodeLike } from '../types.ts'
import type { ShellParser } from './parse.ts'

let parser: ShellParser

beforeAll(async () => {
  parser = await getTestParser()
})

describe('(( reparse: subshell that immediately opens a subshell', () => {
  it('parses as nested subshells rather than an arithmetic command', () => {
    const root = parser.parse('((echo a); echo b)')
    expect(root.hasError).toBe(false)
    expect(root.namedChildren[0]?.type).toBe('subshell')
  })

  it('handles the backgrounded form', () => {
    expect(parser.parse('((echo s1; echo s2) & wait)').hasError).toBe(false)
  })

  it('leaves a genuine arithmetic command untouched', () => {
    expect(parser.parse('i=1; ((i++)); echo $i').hasError).toBe(false)
  })

  // Each opener is judged on its own span, not on the error region:
  // tree-sitter's ERROR swallows the valid `((i++))` next to the bad
  // opener, so scope alone would split both and silently turn the
  // arithmetic into a subshell running `i++`.
  it('handles a line mixing arithmetic and a nested subshell', () => {
    expect(parser.parse('i=1; ((i++)); ((echo x); echo $i)').hasError).toBe(false)
  })

  it('is not confused by a paren inside quotes', () => {
    expect(parser.parse('((echo ")"); echo b)').hasError).toBe(false)
  })

  it('handles two nested subshells on one line', () => {
    expect(parser.parse('((echo a); echo b); ((echo c); echo d)').hasError).toBe(false)
  })

  it('multibyte text before the opener does not shift offsets', () => {
    expect(parser.parse('echo é; ((echo a); echo b)').hasError).toBe(false)
  })

  it('still reports an unrelated syntax error', () => {
    expect(parser.parse('if then').hasError).toBe(true)
  })
})

// tree-sitter-bash 0.25.1 drops a later unbraced `$var` out of its word
// when the name is cut short by a name-terminating character: the `$`
// stays behind as a literal token and the rest splits into a sibling
// word (`/api/$c/$id.json` -> `/api/$c/$` + `id.json`). parse() rebraces
// the orphaned expansion and reparses, so consumers see one whole word.
describe('$ reparse: later unbraced var cut off from its name', () => {
  it.each([
    ['echo hi > /api/$c/$id.json', '/api/$c/${id}.json'],
    ['echo hi > /api/$c/$id-x', '/api/$c/${id}-x'],
    ['echo hi > /w/$a/$b/$c', '/w/$a/${b}/$c'],
    ['echo hi > ${a}.$b.json', '${a}.${b}.json'],
    ['echo hi > /w/$c/$1.json', '/w/$c/${1}.json'],
    ['echo hi > /w/$c/$12.json', '/w/$c/${1}2.json'],
    ['echo hi > /é💡/$c/$123abc.json', '/é💡/$c/${1}23abc.json'],
    ['echo hi > /w/$c/$_id9.json', '/w/$c/${_id9}.json'],
  ])('keeps the redirect target of %j one word', (command, target) => {
    const statement = parser.parse(command).children[0] as TSNodeLike
    expect(statement.type).toBe('redirected_statement')
    const [, redirects] = getRedirects(statement)
    expect(redirects).toHaveLength(1)
    expect(redirects[0]?.target).toBe(target)
  })

  it('keeps a bare word one argument', () => {
    const command = parser.parse('echo /api/$c/$id.json').children[0] as TSNodeLike
    expect(getParts(command).map((p) => getText(p))).toEqual(['echo', '/api/$c/${id}.json'])
  })

  it('keeps an assignment one assignment', () => {
    // The broken parse split this into an assignment holding
    // `p=/api/$c/$` plus a command named `id.json`.
    const node = parser.parse('p=/api/$c/$id.json').namedChildren[0]
    expect(node?.type).toBe('variable_assignment')
    expect(getText(node as TSNodeLike)).toBe('p=/api/$c/${id}.json')
  })

  it.each([
    // A `$` bash keeps literal is left alone: no name character follows.
    ['echo a$ b', ['echo', 'a$', 'b']],
    ['echo $', ['echo', '$']],
  ])('leaves the literal dollar in %j untouched', (command, words) => {
    const node = parser.parse(command).children[0] as TSNodeLike
    expect(getParts(node).map((p) => getText(p))).toEqual(words)
  })
})

describe('a backslash opening a word', () => {
  it.each([
    [
      'echo a\n\\echo b',
      [
        ['echo', 'a'],
        ['\\echo', 'b'],
      ],
    ],
    [
      'echo a # c\n\\echo b',
      [
        ['echo', 'a'],
        ['\\echo', 'b'],
      ],
    ],
    ['export a\n\\echo b', [['\\echo', 'b']]],
    ['echo a \\ b \\\tc', [['echo', 'a', '\\ b', '\\\tc']]],
    ['echo a\n\\ b', [['echo', 'a'], ['\\ b']]],
  ])('keeps it in the word in %j', (command, commands) => {
    // Pinned against bash 5.2.37: the backslash escapes the word's first
    // character, so the newline before it still ends the command and an
    // escaped blank is the word's own.
    const root = parser.parse(command)
    const got = root.namedChildren
      .filter((node) => node.type === 'command')
      .map((node) => getParts(node as TSNodeLike).map((p) => getText(p)))
    expect(got).toEqual(commands)
  })
})
