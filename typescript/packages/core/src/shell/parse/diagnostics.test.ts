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
