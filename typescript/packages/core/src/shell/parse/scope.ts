import { parseProgram } from './parse.ts'
import type { ParsedProgram } from './program.ts'
import type { ShellNode } from '../types.ts'

/** A line and its asynchronous jobs share ownership of incidental parses. */
export class ParseScope {
  private references = 1
  private readonly programs: ParsedProgram[] = []
  private released = false

  parse(command: string, aliases: ReadonlySet<string> = new Set(), extglob = true): ShellNode {
    if (this.references === 0) throw new Error('parse scope is released')
    const program = parseProgram(command, aliases, extglob)
    this.programs.push(program)
    return program.root
  }

  fork(): ParseScope {
    return new ParseScope()
  }

  retain(): () => void {
    if (this.references === 0) throw new Error('parse scope is released')
    this.references += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.drop()
    }
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.drop()
  }

  private drop(): void {
    this.references -= 1
    if (this.references !== 0) return
    for (const program of this.programs) program.release()
    this.programs.length = 0
  }
}
