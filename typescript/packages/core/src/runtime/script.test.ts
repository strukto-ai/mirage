import { describe, expect, it } from 'vitest'
import { LanguageRuntime } from './language.ts'
import { ScriptSource } from './types.ts'
import { scriptEngine } from './script.ts'

describe('scriptEngine', () => {
  it('builds the named runtime', () => {
    const engine = scriptEngine(new ScriptSource('...', 'python'), 'monty')
    expect(engine.name).toBe('monty')
    expect(engine).toBeInstanceOf(LanguageRuntime)
  })

  it.each<[string, 'js' | 'python', string, RegExp]>([
    ['one that runs no programs', 'js', 'workspace', /runs no programs/],
    ['an unknown one', 'js', 'nope', /unknown runtime/],
    ['one of the wrong language', 'python', 'quickjs', /python, but names runtime/],
  ])('refuses a runtime: %s', (_name, language, runtime, refusal) => {
    expect(() => scriptEngine(new ScriptSource('...', language), runtime)).toThrow(refusal)
  })
})
