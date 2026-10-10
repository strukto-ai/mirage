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
import { CHUNK_SIZE } from '../../io/cooperative.ts'
import { concat } from '../../utils/bytes.ts'
import { Recorder } from '../descriptors.ts'
import { Channel, JobConsole, Tee, Terminal } from './index.ts'

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)

const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A reader that lets the loop turn before it takes each chunk. */
class Paced extends JobConsole {
  override async emit(channel: Channel, data: Uint8Array): Promise<void> {
    await turn()
    await super.emit(channel, data)
  }
}

/** Write a numbered line as a job on every turn of the loop until `stop.done`. */
async function writeUntil(tty: Terminal, stop: { done: boolean }): Promise<void> {
  let count = 0
  while (!stop.done) {
    count += 1
    await tty.jobs.emit(Channel.STDOUT, enc(`${String(count)}\n`))
    await turn()
  }
}

/** A reader whose writes wait for `release`. */
class Stalled extends JobConsole {
  release: () => void = () => undefined
  private enter: () => void = () => undefined
  readonly entered = new Promise<void>((resolve) => (this.enter = resolve))
  private readonly released = new Promise<void>((resolve) => (this.release = resolve))

  override async emit(channel: Channel, data: Uint8Array): Promise<void> {
    this.enter()
    await this.released
    await super.emit(channel, data)
  }
}
const dec = ([out, err]: [Uint8Array, Uint8Array]): [string, string] => [
  new TextDecoder().decode(out),
  new TextDecoder().decode(err),
]

describe('Terminal', () => {
  it('a line takes what reached the terminal in order', async () => {
    const tty = new Terminal()
    await tty.jobs.emit(Channel.STDOUT, enc('early\n'))
    await tty.emit(Channel.STDOUT, enc('line\n'))
    await tty.emit(Channel.STDERR, enc('warn\n'))
    await tty.jobs.emit(Channel.STDOUT, enc('late\n'))
    expect(dec(tty.take())).toEqual(['early\nline\nlate\n', 'warn\n'])
    expect(dec(tty.take())).toEqual(['', ''])
  })

  it('a job writes into the statement running', async () => {
    const tty = new Terminal()
    const statement = new Recorder()
    tty.jobs.recorder = statement
    await tty.jobs.emit(Channel.STDOUT, enc('bg\n'))
    tty.jobs.recorder = null
    await tty.jobs.emit(Channel.STDOUT, enc('after\n'))
    expect(statement.chunks).toEqual([[Channel.STDOUT, enc('bg\n')]])
    expect(dec(tty.take())).toEqual(['after\n', ''])
  })

  it('a reader gets what waited and then everything', async () => {
    const tty = new Terminal()
    await tty.jobs.emit(Channel.STDOUT, enc('waited\n'))
    const reader = new JobConsole()
    await tty.attach(reader)
    await tty.emit(Channel.STDOUT, enc('now\n'))
    expect(new TextDecoder().decode(await reader.snapshot(Channel.STDOUT))).toBe('waited\nnow\n')
    expect(dec(tty.take())).toEqual(['', ''])
  })

  it('a job writing while a reader attaches lands after what waited', async () => {
    const tty = new Terminal()
    await tty.jobs.emit(Channel.STDOUT, enc('one\n'))
    await tty.jobs.emit(Channel.STDOUT, enc('two\n'))
    const reader = new Stalled()
    const attach = tty.attach(reader)
    await reader.entered
    let landed = false
    const job = tty.jobs.emit(Channel.STDOUT, enc('meanwhile\n')).then(() => {
      landed = true
    })
    await turn()
    expect(landed).toBe(false)
    reader.release()
    await attach
    await job
    expect(new TextDecoder().decode(await reader.snapshot(Channel.STDOUT))).toBe(
      'one\ntwo\nmeanwhile\n',
    )
    expect(tty.reader).toBe(reader)
  })

  it('bounds the streamed stdout prefix and resets it per line', async () => {
    const tty = new Terminal()
    await tty.jobs.emit(Channel.STDOUT, enc('queued '))
    const reader = new JobConsole()
    await tty.attach(reader)
    const payload = enc('€'.repeat(CHUNK_SIZE))
    await tty.emit(Channel.STDOUT, payload.subarray(0, 2))
    await tty.emit(Channel.STDERR, enc('warning'))
    await tty.emit(Channel.STDOUT, payload.subarray(2))
    const shown = concat([enc('queued '), payload])
    expect(tty.stdoutPrefix).toEqual(shown.subarray(0, CHUNK_SIZE))
    expect(await reader.snapshot(Channel.STDOUT)).toEqual(shown)
    expect(dec(tty.take())).toEqual(['', ''])
    expect(tty.stdoutPrefix.byteLength).toBe(0)
    await tty.attach(new JobConsole())
    await tty.emit(Channel.STDOUT, enc('next'))
    expect(tty.stdoutPrefix).toEqual(enc('next'))
    tty.dropLine()
    expect(tty.stdoutPrefix.byteLength).toBe(0)
  })

  it('a noisy job does not hold a reader from attaching', async () => {
    const tty = new Terminal()
    const stop = { done: false }
    const job = writeUntil(tty, stop)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const reader = new Paced()
    await tty.attach(reader)
    expect(tty.reader).toBe(reader)
    stop.done = true
    await job
    const lines = new TextDecoder()
      .decode(await reader.snapshot(Channel.STDOUT))
      .split('\n')
      .filter((line) => line !== '')
    expect(lines).toEqual(lines.map((_, i) => String(i + 1)))
  }, 1000)

  it('a line ended while its reader attaches never attaches it', async () => {
    const tty = new Terminal()
    await tty.jobs.emit(Channel.STDOUT, enc('waited\n'))
    const reader = new Stalled()
    const attach = tty.attach(reader)
    await reader.entered
    const job = tty.jobs.emit(Channel.STDOUT, enc('meanwhile\n'))
    await turn()
    tty.dropLine()
    await job
    reader.release()
    await attach
    expect(tty.reader).toBeNull()
    await tty.jobs.emit(Channel.STDOUT, enc('later\n'))
    expect(dec(tty.take())).toEqual(['meanwhile\nlater\n', ''])
  })

  it('an abandoned line keeps only its jobs output', async () => {
    const tty = new Terminal()
    await tty.emit(Channel.STDOUT, enc('line\n'))
    await tty.jobs.emit(Channel.STDOUT, enc('job\n'))
    tty.dropLine()
    expect(dec(tty.take())).toEqual(['job\n', ''])
  })

  it('bounded output goes back ahead of later output', async () => {
    const tty = new Terminal()
    await tty.emit(Channel.STDOUT, enc('long line\n'))
    const [out, err] = tty.drain()
    await tty.jobs.emit(Channel.STDOUT, enc('later\n'))
    tty.putBack(out.subarray(0, 4), err)
    expect(dec(tty.take())).toEqual(['longlater\n', ''])
  })
})

describe('Tee', () => {
  it('keeps the console and copies the bytes', async () => {
    const console_ = new JobConsole()
    const copy = new JobConsole()
    await new Tee(console_, copy).emit(Channel.STDOUT, enc('x'))
    expect(new TextDecoder().decode(await console_.snapshot(Channel.STDOUT))).toBe('x')
    expect(new TextDecoder().decode(await copy.snapshot(Channel.STDOUT))).toBe('x')
  })
})
