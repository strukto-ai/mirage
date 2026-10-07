import type { ShellParser } from './parse.ts'
import type { ParsedProgram } from './program.ts'
import type { ShellNode, TSNodeLike } from '../types.ts'

/** A line and its asynchronous jobs share ownership of incidental parses. */
export class ParseScope {
  private references = 1
  private readonly programs: ParsedProgram[] = []
  private released = false

  constructor(private readonly parser: ShellParser) {}

  parse(command: string): ShellNode {
    return this.program(command).root
  }

  /** Parse source with its alias grammar and retain the owned result. */
  program(
    command: string,
    aliases: ReadonlySet<string> = new Set(),
    own: ReadonlyMap<string, readonly [number, number]> = new Map(),
  ): ParsedProgram {
    if (this.references === 0) throw new Error('parse scope is released')
    const program = this.parser.parseProgram(command, aliases, own)
    this.programs.push(program)
    return program
  }

  fork(): ParseScope {
    return new ParseScope(this.parser)
  }

  sourceOffsets(command: string, root: TSNodeLike): readonly number[] {
    return this.parser.sourceOffsets(command, root)
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
