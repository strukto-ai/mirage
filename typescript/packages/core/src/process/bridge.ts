import { PathSpec } from '../types.ts'
import type { ProcessView } from './types.ts'

export class GuestProcesses {
  constructor(private readonly view: ProcessView | null) {}
  async run(
    argv: string[],
    input = '',
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string; returncode: number }> {
    if (this.view?.spawn === undefined) throw new Error('runtime has no process spawn door')
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((arg) => typeof arg === 'string'))
      throw new Error('argv must be a nonempty list of strings')
    const child = this.view.spawn({
      argv,
      ...(cwd === undefined ? {} : { cwd: PathSpec.fromStrPath(cwd) }),
    })
    const result = await child.communicate(new TextEncoder().encode(input))
    return {
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
      returncode: result.exitCode,
    }
  }
}
