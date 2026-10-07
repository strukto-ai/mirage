import { assert, expect, it } from 'vitest'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'

it('reports diagnostics in the original Unicode source after recovery', async () => {
  const parser = await getTestParser()
  const line = 'echo é💡; value=x 2>/dev/null; fi'
  const program = parser.parseProgram(line)
  try {
    expect(program.diagnostics[0]?.offending).toBe('fi')
    const diagnostic = program.diagnostics[0]
    assert(diagnostic)
    const span = diagnostic.span
    expect(line.slice(span.start, span.end)).toBe('fi')
    expect(program.root.text).toBe(line)
  } finally {
    program.release()
  }
})

it.each([
  ['echo $(echo ok; fi)', 'fi'],
  ['x=$(echo ok; done)', 'done'],
  ['echo $(echo $(fi))', 'fi'],
])('keeps the span of a stray word inside a substitution: %s', async (line, word) => {
  const program = (await getTestParser()).parseProgram(line)
  try {
    expect(program.diagnostics).toHaveLength(1)
    const diagnostic = program.diagnostics[0]
    assert(diagnostic)
    expect(diagnostic.offending).toBe(word)
    expect(line.slice(diagnostic.span.start, diagnostic.span.end)).toBe(word)
  } finally {
    program.release()
  }
})
