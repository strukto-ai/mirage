import { expect, it, vi } from 'vitest'
import type { ParsedProgram } from '../../shell/parse/program.ts'
import { Workspace } from '../workspace/workspace.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'

it('executes only after the owned program diagnostics admit the line', async () => {
  const parser = await getTestParser()
  const parse = parser.parseProgram.bind(parser)
  const programs: ParsedProgram[] = []
  const spy = vi.spyOn(parser, 'parseProgram').mockImplementation((...args) => {
    const program = parse(...args)
    vi.spyOn(program, 'diagnostics', 'get').mockReturnValue([
      { offending: 'injected', span: { start: 0, end: 1 }, message: 'owned refusal\n' },
    ])
    programs.push(program)
    return program
  })
  const ws = new Workspace({}, { shellParser: parser })
  try {
    const result = await ws.shell('echo must-not-run')
    expect([result.exitCode, result.stdoutText, result.stderrText]).toEqual([
      2,
      '',
      'owned refusal\n',
    ])
    expect(programs.every((p) => p.references === 0)).toBe(true)
  } finally {
    spy.mockRestore()
    await ws.close()
  }
})
