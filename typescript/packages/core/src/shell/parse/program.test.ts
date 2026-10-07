import { afterEach, assert, describe, expect, it, vi } from 'vitest'
import { Parser } from 'web-tree-sitter'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { getFunctionBody } from '../helpers.ts'
import { retainPrograms } from './program.ts'

afterEach(() => vi.restoreAllMocks())

describe('owned programs', () => {
  it('retains invocation nodes independently of the parsing scope', async () => {
    const parser = await getTestParser()
    const program = parser.parseProgram('f() { echo hello; } 2>/dev/null')
    const definition = program.root.namedChildren[0]
    assert(definition)
    const body = getFunctionBody(definition)
    assert(body)
    const first = body[0]
    assert(first)
    const invoke = retainPrograms(body)
    program.release()
    expect(first.text).toContain('echo hello')
    expect(program.references).toBe(1)
    invoke()
    invoke()
    expect(program.references).toBe(0)
    expect(() => first.children[0]?.text).toThrow('released')
  })
})

it('diagnoses a program once, when first read, without parsing again', async () => {
  const parser = await getTestParser()
  const parses = vi.spyOn(Parser.prototype, 'parse')
  const program = parser.parseProgram('echo $(echo a |)')
  try {
    const parsed = parses.mock.calls.length
    expect(program.diagnostics).toHaveLength(1)
    expect(program.diagnostics).toBe(program.diagnostics)
    expect(parses.mock.calls.length).toBe(parsed)
  } finally {
    program.release()
  }
  expect(() => program.diagnostics).toThrow('released')
})
