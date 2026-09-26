import { describe, expect, it } from 'vitest'
import { Channel } from '../shell/console/index.ts'
import { PathSpec } from '../types.ts'
import { ChildProcess } from './child.ts'
import { ProcessInput, ProcessOutput } from './stdio.ts'
import { ProcessSupervisor } from './supervisor.ts'
import type { ProcessRunner } from './types.ts'

function spawnChild(
  stdin: ProcessInput,
  output: ProcessOutput,
  run: (signal: AbortSignal) => ReturnType<ProcessRunner>,
): ChildProcess {
  const abort = new AbortController()
  const process = new ProcessSupervisor().start({
    sessionId: 'a',
    command: 'child',
    cwd: PathSpec.fromStrPath('/'),
    run: () => run(abort.signal),
    cancel: () => {
      abort.abort()
    },
  })
  return new ChildProcess(process, stdin, output, () => process.terminate())
}

describe('ChildProcess', () => {
  it('communicate feeds stdin and drains both outputs', async () => {
    const stdin = new ProcessInput(),
      output = new ProcessOutput()
    const child = spawnChild(stdin, output, async () => {
      let data = ''
      for await (const chunk of stdin.stream()) data += new TextDecoder().decode(chunk)
      await output.emit(Channel.STDOUT, new TextEncoder().encode(data.toUpperCase()))
      await output.emit(Channel.STDERR, new TextEncoder().encode('warn'))
      return 3
    })
    expect(child.poll()).toBeNull()
    const result = await child.communicate(new TextEncoder().encode('hello'))
    expect(new TextDecoder().decode(result.stdout)).toBe('HELLO')
    expect(new TextDecoder().decode(result.stderr)).toBe('warn')
    expect(result.exitCode).toBe(3)
    expect(child.poll()).toBe(3)
  })

  it('terminate cancels a child that never answers', async () => {
    let started: () => void = () => undefined
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const child = spawnChild(
      new ProcessInput(),
      new ProcessOutput(),
      (signal) =>
        new Promise<number>((_, reject) => {
          started()
          signal.addEventListener(
            'abort',
            () => {
              reject(new DOMException('aborted', 'AbortError'))
            },
            { once: true },
          )
        }),
    )
    await running
    child.terminate()
    expect(await child.wait()).toMatchObject({ exitCode: 137, cancellationRequested: true })
    expect(child.poll()).toBe(137)
  })
})
