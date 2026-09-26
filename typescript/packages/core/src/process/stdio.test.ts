import { describe, expect, it } from 'vitest'
import { Channel } from '../shell/console/index.ts'
import { PipeClosed } from '../shell/errors.ts'
import { ProcessInput, ProcessOutput } from './stdio.ts'

const dec = new TextDecoder()

async function read(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let out = ''
  for await (const chunk of stream) out += dec.decode(chunk)
  return out
}

describe('process stdio', () => {
  it('counts what its reader consumed', async () => {
    const pipe = new ProcessInput()
    const reader = read(pipe.stream())
    await pipe.write(new TextEncoder().encode('x'.repeat(200000)))
    pipe.close()
    expect(await reader).toBe('x'.repeat(200000))
    expect(pipe.bytesRead).toBe(200000)
  })

  it('refuses writes once closed', async () => {
    const pipe = new ProcessInput()
    pipe.close()
    await pipe.write(new Uint8Array())
    await expect(pipe.write(new TextEncoder().encode('late'))).rejects.toBeInstanceOf(PipeClosed)
  })

  it.each([
    [false, ['out', 'err']],
    [true, ['outerr', '']],
  ])('routes stderr to its own pipe unless merged (%s)', async (merged, expected) => {
    const output = new ProcessOutput(merged)
    const reads = Promise.all([read(output.stdout.stream()), read(output.stderr.stream())])
    await output.emit(Channel.STDOUT, new TextEncoder().encode('out'))
    await output.emit(Channel.STDERR, new TextEncoder().encode('err'))
    output.end()
    expect(await reads).toEqual(expected)
  })
})
