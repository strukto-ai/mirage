import { assert, describe, expect, it } from 'vitest'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { getFunctionBody } from '../helpers.ts'
import { retainPrograms } from './program.ts'

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
