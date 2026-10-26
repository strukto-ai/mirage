import { expect, it } from 'vitest'
import { ParseScope } from '../../shell/parse/scope.ts'
import { EvaluationContext } from '../evaluation.ts'
import { SessionState } from '../session/session.ts'
import { diagnosticStderr } from './diagnostics.ts'
import { parse } from '../../shell/parse/parse.ts'

it.each([
  ['printf x', 'bash: printf: '],
  ['export X=x', 'bash: export: '],
  ['cat f', 'bash: '],
])('preserves diagnostic bytes and order for %s', (line, prefix) => {
  const context = new EvaluationContext(new SessionState({ sessionId: 'diagnostic-test' }))
  const parser = new ParseScope()
  try {
    const node = parse(line)
    expect(diagnosticStderr(node, context)).toEqual(new Uint8Array())
    context.frame.diagnostics = [
      new TextEncoder().encode('child warning\n'),
      'invalid name',
      new Uint8Array([255]),
    ]
    expect(diagnosticStderr(node, context)).toEqual(
      new Uint8Array([
        ...new TextEncoder().encode('child warning\n' + prefix + 'invalid name\n'),
        255,
      ]),
    )
  } finally {
    parser.release()
  }
})
