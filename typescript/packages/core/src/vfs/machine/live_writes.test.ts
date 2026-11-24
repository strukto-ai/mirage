// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { describe, expect, it } from 'vitest'
import { ScriptedMachine, failed, tableOf, type Answer } from '../../../tests/fixtures/machine.ts'
import { FakeFiles, shared, spec, texts } from '../../../tests/fixtures/machine_files.ts'
import { bindCaller, currentCaller } from '../../context/session_context.ts'
import { MachineName } from '../../execution/types.ts'
import type { ByteSource } from '../../io/types.ts'
import type { OutputFn, RunResult } from '../../runtime/types.ts'
import { MachineVFS } from './machine.ts'

const ENC = new TextEncoder()

/** Run `fn` as a program running on machine `name`. */
function runningOn<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return bindCaller({ ...currentCaller(), machine: new MachineName('scripted', name) }, fn)
}

/** Write a name as a program's `>` (or `>>`, with `append`) on machine `name` does. */
function writeOn(
  name: string,
  vfs: MachineVFS,
  path: string,
  data: ByteSource,
  append = false,
): Promise<void> {
  return runningOn(name, () =>
    append ? vfs.append(spec(path), data) : vfs.write(spec(path), data),
  )
}

describe('a landed write', () => {
  it.each(['write', 'copy'])(
    "leaves another machine's live write of the name: %s",
    async (landing) => {
      const a = new FakeFiles({ '/tmp/src': 'from a\n' })
      const b = new FakeFiles({ '/tmp/k': 'old\n' })
      const vfs = shared(a, b)
      let pulled = (): void => undefined
      const started = new Promise<void>((resolve) => {
        pulled = resolve
      })
      let release = (): void => undefined
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      async function* slow(): AsyncGenerator<Uint8Array> {
        pulled()
        await released
        yield ENC.encode('from b\n')
      }
      const writing = writeOn('b', vfs, '/k', slow())
      await started
      if (landing === 'write') await writeOn('a', vfs, '/k', ENC.encode('from a\n'))
      else await vfs.copy(spec('/src'), spec('/k'))
      expect([texts(a)['/tmp/k'], b.files.has('/tmp/k')]).toEqual(['from a\n', true])
      release()
      await writing
      expect([a.files.has('/tmp/k'), texts(b)['/tmp/k']]).toEqual([false, 'from b\n'])
    },
  )

  it('leaves the copy landed meanwhile when a live write fails', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({ '/tmp/k': 'old\n' })
    b.written.set('/tmp/k', 2_000_000_000)
    const vfs = shared(a, b)
    let pulled = (): void => undefined
    const started = new Promise<void>((resolve) => {
      pulled = resolve
    })
    let release = (): void => undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const failing: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<Uint8Array>> => {
          pulled()
          await released
          throw new Error('EIO')
        },
      }),
    }
    const writing = writeOn('b', vfs, '/k', failing)
    await started
    await writeOn('a', vfs, '/k', ENC.encode('from a\n'))
    release()
    await expect(writing).rejects.toThrow('EIO')
    expect([texts(a)['/tmp/k'], b.files.has('/tmp/k')]).toEqual(['from a\n', false])
  })

  it('keeps the copy of the write that ends last', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles({ '/tmp/k': 'old\n' })
    const vfs = shared(a, b)
    let pulled = (): void => undefined
    const started = new Promise<void>((resolve) => {
      pulled = resolve
    })
    let release = (): void => undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    async function* slow(): AsyncGenerator<Uint8Array> {
      pulled()
      await released
      yield ENC.encode('from b\n')
    }
    const writing = vfs.write(spec('/k'), slow())
    await started
    await writeOn('a', vfs, '/k', ENC.encode('from a\n'))
    release()
    await writing
    expect([a.files.has('/tmp/k'), texts(b)['/tmp/k']]).toEqual([false, 'from b\n'])
  })

  it('leaves one copy when writes on two machines end together', async () => {
    const machines = { a: new FakeFiles(), b: new FakeFiles() }
    const vfs = shared(machines.a, machines.b)
    let release = (): void => undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const pulled: Promise<void>[] = []
    function held(name: string): AsyncGenerator<Uint8Array> {
      let started = (): void => undefined
      pulled.push(
        new Promise<void>((resolve) => {
          started = resolve
        }),
      )
      return (async function* (): AsyncGenerator<Uint8Array> {
        started()
        await released
        yield ENC.encode(`from ${name}\n`)
      })()
    }
    const writes = Object.keys(machines).map((name) => writeOn(name, vfs, '/k', held(name)))
    await Promise.all(pulled)
    release()
    await Promise.all(writes)
    const kept = Object.entries(machines).filter(([, files]) => files.files.has('/tmp/k'))
    expect(kept).toHaveLength(1)
    expect(kept.map(([name, files]) => [name, texts(files)['/tmp/k']])).toEqual(
      kept.map(([name]) => [name, `from ${name}\n`]),
    )
  })
})

/** A machine whose next line holding every part `armed` names waits for `go`. */
class Gated extends ScriptedMachine {
  armed: readonly string[] = []
  private markHeld: () => void = () => undefined
  readonly held = new Promise<void>((resolve) => {
    this.markHeld = resolve
  })
  private open: () => void = () => undefined
  private readonly opened = new Promise<void>((resolve) => {
    this.open = resolve
  })

  go(): void {
    this.open()
  }

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn,
    errors: OutputFn,
  ): Promise<RunResult> {
    const line = argv.join(' ')
    if (this.armed.length > 0 && this.armed.every((part) => line.includes(part))) {
      this.armed = []
      this.markHeld()
      await this.opened
    }
    return super.execArgv(argv, stdin, env, cwd, output, errors)
  }
}

describe('a settling', () => {
  it('keeps a copy landed while it looks', async () => {
    const aFiles = new FakeFiles()
    const bFiles = new FakeFiles()
    const a = new Gated('a', aFiles.answer)
    const vfs = new MachineVFS({ root: '/tmp' })
    vfs.bindMachines(tableOf(a, new ScriptedMachine('b', bFiles.answer)), 'a')
    a.armed = ['/tmp/k', '-maxdepth 0']
    const first = writeOn('b', vfs, '/k', ENC.encode('from b\n'))
    await a.held
    await writeOn('a', vfs, '/k', ENC.encode('from a\n'))
    a.go()
    await first
    expect([texts(aFiles)['/tmp/k'], bFiles.files.has('/tmp/k')]).toEqual(['from a\n', false])
  })

  it('never takes with a removal a copy written after it began', async () => {
    const aFiles = new FakeFiles()
    const bFiles = new FakeFiles({ '/tmp/k': 'old\n' })
    const b = new Gated('b', bFiles.answer)
    const vfs = new MachineVFS({ root: '/tmp' })
    vfs.bindMachines(tableOf(new ScriptedMachine('a', aFiles.answer), b), 'a')
    b.armed = ['rm --', '/tmp/k']
    const first = writeOn('a', vfs, '/k', ENC.encode('from a\n'))
    await b.held
    const second = writeOn('b', vfs, '/k', ENC.encode('from b\n'))
    await Promise.race([second, new Promise((resolve) => setTimeout(resolve, 200))])
    b.go()
    await Promise.all([first, second])
    expect([aFiles.files.has('/tmp/k'), texts(bFiles)['/tmp/k']]).toEqual([false, 'from b\n'])
  })
})

describe('a settling', () => {
  it('marks a name another machine is still writing', async () => {
    const a = new FakeFiles()
    const b = new FakeFiles()
    const vfs = shared(a, b)
    let pulled = (): void => undefined
    const started = new Promise<void>((resolve) => {
      pulled = resolve
    })
    let release = (): void => undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    async function* slow(): AsyncGenerator<Uint8Array> {
      pulled()
      await released
      yield ENC.encode('from b\n')
    }
    const appending = writeOn('b', vfs, '/k', slow(), true)
    await started
    await writeOn('a', vfs, '/k', ENC.encode('from a\n'))
    release()
    await appending
    expect([a.files.has('/tmp/k'), texts(b)['/tmp/k']]).toEqual([false, 'from b\n'])
  })

  it('shares the failure of a removal under way', async () => {
    const aFiles = new FakeFiles()
    const bFiles = new FakeFiles()
    const cFiles = new FakeFiles({ '/tmp/k': 'old\n' })
    const refusingRm: Answer = (line, data) =>
      line.startsWith('rm ')
        ? failed("rm: cannot remove '/tmp/k': Permission denied\n")
        : cFiles.answer(line, data)
    const c = new Gated('c', refusingRm)
    const vfs = new MachineVFS({ root: '/tmp' })
    vfs.bindMachines(
      tableOf(new ScriptedMachine('a', aFiles.answer), new ScriptedMachine('b', bFiles.answer), c),
      'a',
    )
    c.armed = ['rm --', '/tmp/k']
    const first = writeOn('a', vfs, '/k', ENC.encode('from a\n'))
    const firstDone = first.then(
      () => null,
      (err: unknown) => err,
    )
    await c.held
    const second = writeOn('b', vfs, '/k', ENC.encode('from b\n'))
    const secondDone = second.then(
      () => null,
      (err: unknown) => err,
    )
    await Promise.race([secondDone, new Promise((resolve) => setTimeout(resolve, 200))])
    c.go()
    expect(await firstDone).toMatchObject({ code: 'EACCES' })
    expect(await secondDone).toMatchObject({ code: 'EACCES' })
    expect(texts(cFiles)['/tmp/k']).toBe('old\n')
  })
})
