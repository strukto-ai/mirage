import { beforeAll, describe, expect, it } from 'vitest'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { getRedirects } from '../helpers.ts'
import type { TSNodeLike } from '../types.ts'
import type { ShellParser } from './parse.ts'

let parser: ShellParser

beforeAll(async () => {
  parser = await getTestParser()
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
})
