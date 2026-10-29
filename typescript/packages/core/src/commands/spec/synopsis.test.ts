import { describe, expect, it } from 'vitest'
import { BUILTIN_SPECS, specOf } from './builtins.ts'
import { renderHelp } from './help.ts'
import { SHELL_SPECS } from './shell.ts'
import { SHELL_SYNOPSES, SYNOPSES } from './synopsis.ts'
import { CommandSpec, UsageStyle } from './types.ts'

describe('SYNOPSES', () => {
  it('names a builtin with every entry, each starting with the command', () => {
    for (const [name, line] of Object.entries(SYNOPSES)) {
      expect(BUILTIN_SPECS[name] !== undefined || SHELL_SPECS[name] !== undefined).toBe(true)
      expect(line.split(' ', 1)[0]).toBe(name)
      expect(line.startsWith('Usage:')).toBe(false)
    }
  })

  it('gives every shell synopsis a spec, a builtin starting with its name', () => {
    for (const [name, line] of Object.entries(SHELL_SYNOPSES)) {
      expect(SHELL_SPECS[name]).toBeDefined()
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) expect(line.split(' ', 1)[0]).toBe(name)
    }
  })

  it('replaces the synthesized line when handed in', () => {
    expect(renderHelp('grep', specOf('grep'), [], UsageStyle.ARGPARSE, SYNOPSES.grep)).toContain(
      'Usage: grep [OPTION]... PATTERNS [FILE]...\n',
    )
  })

  it('leaves a spec rendered without one on the synthesized line', () => {
    // The registration site hands the synopsis in only for the builtin's
    // own spec object, so a custom `grep` renders what its spec says.
    const rendered = renderHelp('grep', new CommandSpec({}))
    expect(rendered).toContain('Usage: grep\n')
    expect(rendered).not.toContain('PATTERNS')
  })
})
