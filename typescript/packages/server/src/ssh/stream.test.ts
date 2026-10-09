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

import { PassThrough } from 'node:stream'
import { Channel } from '@struktoai/mirage-core/shell/console/types'
import { ExecutionScope } from '@struktoai/mirage-core/workspace/execution'
import { ShellExecution } from '@struktoai/mirage-core/workspace/shell_execution'
import { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/types'
import { REFUSAL_WINDOW } from './constants.ts'
import type { ServerChannel } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import {
  ChannelInput,
  ChannelOutput,
  LineDiscipline,
  MAX_BUFFERED,
  MAX_LINE,
  MAX_TERMINAL_LINE,
  Mark,
  channelStdin,
  deliver,
} from './stream.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** A channel double: data written in arrives as input; writes are kept. */
class FakeChannel extends PassThrough {
  readonly written: string[] = []
  readonly errors: string[] = []
  readonly stderr = new PassThrough()
  pauses = 0

  constructor() {
    super()
    this.stderr.on('data', (chunk: Buffer) => {
      this.errors.push(chunk.toString())
    })
  }

  send(text: string | Uint8Array): void {
    this.emit('data', Buffer.from(typeof text === 'string' ? enc.encode(text) : text))
  }

  override write(chunk: Uint8Array | string): boolean {
    this.written.push(typeof chunk === 'string' ? chunk : dec.decode(chunk))
    return true
  }

  override pause(): this {
    this.pauses += 1
    return this
  }

  asChannel(): ServerChannel {
    return this as unknown as ServerChannel
  }
}

function started(tty: boolean): [FakeChannel, ChannelInput] {
  const chan = new FakeChannel()
  const input = new ChannelInput(chan.asChannel(), tty)
  input.start()
  return [chan, input]
}

describe('LineDiscipline', () => {
  function run(input: string): { lines: string[]; echo: string; marks: string[] } {
    const lines: string[] = []
    const marks: string[] = []
    let echo = ''
    const d = new LineDiscipline(
      (bytes) => {
        echo += dec.decode(bytes)
      },
      {
        line: (bytes) => lines.push(dec.decode(bytes)),
        interrupt: () => marks.push('interrupt'),
        eof: () => marks.push('eof'),
      },
    )
    d.feed(enc.encode(input))
    return { lines, echo, marks }
  }

  it('echoes what is typed and hands over a line at Enter', () => {
    const out = run('ls -l\r')
    expect(out.lines).toEqual(['ls -l\n'])
    expect(out.echo).toBe('ls -l\r\n')
  })

  it('treats CRLF as one Enter', () => {
    expect(run('a\r\nb\n').lines).toEqual(['a\n', 'b\n'])
  })

  it('erases one code point per Backspace', () => {
    const out = run('café\x7f\x7fe\r')
    expect(out.lines).toEqual(['cae\n'])
    expect(out.echo.endsWith('\b \b\b \be\r\n')).toBe(true)
  })

  it('erases the whole line on Ctrl-U', () => {
    expect(run('wrong\x15ok\r').lines).toEqual(['ok\n'])
  })

  it('drops the half-typed line on Ctrl-C', () => {
    const out = run('half\x03next\r')
    expect(out.marks).toEqual(['interrupt'])
    expect(out.lines).toEqual(['next\n'])
  })

  it('reports Ctrl-D only on an empty line', () => {
    expect(run('\x04').marks).toEqual(['eof'])
    expect(run('x\x04\r').marks).toEqual([])
  })

  it('swallows escape sequences such as arrow keys', () => {
    expect(run('a\x1b[Ab\x1bOPc\r').lines).toEqual(['abc\n'])
  })
})

describe('ChannelInput', () => {
  it('splits chunks into lines and ends at EOF', async () => {
    const [chan, input] = started(false)
    chan.send('ec')
    chan.send('ho a\npw')
    chan.send('d\n')
    chan.emit('end')
    expect(dec.decode((await input.readline()) as Uint8Array)).toBe('echo a\n')
    expect(dec.decode((await input.readline()) as Uint8Array)).toBe('pwd\n')
    expect(await input.readline()).toBe(Mark.EOF)
  })

  it('returns a final unterminated line as a line', async () => {
    const [chan, input] = started(false)
    chan.send('exit 3')
    chan.emit('end')
    expect(dec.decode((await input.readline()) as Uint8Array)).toBe('exit 3')
    expect(await input.readline()).toBe(Mark.EOF)
  })

  it('hands a running line its stdin and stops at Ctrl-D', async () => {
    const [chan, input] = started(true)
    chan.send('cat\r')
    expect(dec.decode((await input.readline()) as Uint8Array)).toBe('cat\n')
    chan.send('a\rb\r\x04next\r')
    const chunks: string[] = []
    for await (const chunk of channelStdin(input)) chunks.push(dec.decode(chunk))
    expect(chunks).toEqual(['a\n', 'b\n'])
    expect(dec.decode((await input.readline()) as Uint8Array)).toBe('next\n')
  })

  it('queues an interrupt typed at the prompt in band', async () => {
    const [chan, input] = started(true)
    chan.send('half\x03ls\r')
    expect(await input.readline()).toBe(Mark.INTERRUPT)
    expect(dec.decode((await input.readline()) as Uint8Array)).toBe('ls\n')
  })

  it('routes an interrupt to the running line handler', () => {
    const [chan, input] = started(true)
    let hits = 0
    input.onInterrupt(() => {
      hits += 1
    })
    chan.send('\x03')
    input.interruptReceived()
    expect(hits).toBe(2)
  })

  it('pauses the channel once the buffer is full', () => {
    const [chan] = started(false)
    chan.send(new Uint8Array(MAX_BUFFERED))
    expect(chan.pauses).toBe(1)
  })
})

function produced(
  result: ExecuteResult,
  ...events: [(typeof Channel)['STDOUT' | 'STDERR'], string][]
): ShellExecution {
  return new ShellExecution(async (output) => {
    for (const [channel, data] of events) await output.emit(channel, enc.encode(data))
    return result
  }, new ExecutionScope())
}

describe('ChannelOutput', () => {
  it('folds stderr into stdout on a terminal and writes CRLF there', async () => {
    const plain = new FakeChannel()
    const tty = new FakeChannel()
    await new ChannelOutput(plain.asChannel(), false).write(enc.encode('e\n'), true)
    await new ChannelOutput(tty.asChannel(), true).write(enc.encode('e\n'), true)
    await new Promise((r) => setImmediate(r))
    expect([plain.written, plain.errors]).toEqual([[], ['e\n']])
    expect([tty.written, tty.errors]).toEqual([['e\r\n'], []])
  })

  it('delivers output in the order it was produced', async () => {
    const sent: [string, boolean][] = []
    const execution = produced(
      new ExecuteResult(new Uint8Array(0), new Uint8Array(0), 3),
      [Channel.STDOUT, 'one'],
      [Channel.STDOUT, ''],
      [Channel.STDERR, 'warn'],
      [Channel.STDOUT, 'two'],
    )
    const result = await deliver(execution, (data, stderr) => {
      sent.push([new TextDecoder().decode(data), stderr])
      return Promise.resolve()
    })
    expect(sent).toEqual([
      ['one', false],
      ['warn', true],
      ['two', false],
    ])
    expect(result.exitCode).toBe(3)
  })

  it('delivers output before the line ends', async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let first!: () => void
    const reached = new Promise<void>((resolve) => (first = resolve))
    const execution = new ShellExecution(async (output) => {
      await output.emit(Channel.STDOUT, enc.encode('ready'))
      await released
      return new ExecuteResult(new Uint8Array(0), new Uint8Array(0), 0)
    }, new ExecutionScope())
    let done = false
    const delivering = deliver(execution, () => {
      first()
      return Promise.resolve()
    }).finally(() => (done = true))
    await reached
    expect(done).toBe(false)
    release()
    await delivering
  })

  const W = REFUSAL_WINDOW
  const said = "rm: cannot remove '/data': Device or resource busy\n"
  const busy = "cannot remove '/data': Device or resource busy"
  const more = 'y'.repeat(W * 4)
  it.each([
    ['appended', '', "rm: cannot remove 'x': Permission denied\n", 'sealed', false],
    // A mount root's EBUSY lets the rest of the line run, so its
    // diagnostic can sit at either end of a long output, or end right at
    // the first window with its newline the next byte.
    ['end', more, more + said, busy, true],
    ['start', more, said + more, busy, true],
    ['window edge', more, 'f'.repeat(W - said.length) + '\n' + said + more, busy, true],
    // A long line cut right after the reason's words says nothing.
    ['cut line', 'a'.repeat(W - 8) + ': sealed' + 'z'.repeat(64) + '\n', '', 'sealed', false],
  ] as const)(
    'appends the refusal unless the output says why: %s',
    async (_case, stdout, stderr, reason, saysWhy) => {
      const errors: string[] = []
      const refused = new ExecuteResult(new Uint8Array(0), new Uint8Array(0), 1, {
        kind: 'deny',
        reason,
        policy: '',
        scope: 'operand',
        askId: null,
      })
      const execution = produced(refused, [Channel.STDOUT, stdout], [Channel.STDERR, stderr])
      await deliver(execution, (data, stderr) => {
        if (stderr) errors.push(new TextDecoder().decode(data))
        return Promise.resolve()
      })
      expect(errors.at(-1) === `policy denied: ${reason}\n`).toBe(!saysWhy)
    },
  )
})

describe('input limits', () => {
  it.each(['x', 'x\n', 'xx\nignored\n'])('bounds a line across chunks: %j', async (tail) => {
    const [chan, input] = started(false)
    const line = input.readline()
    chan.send('a'.repeat(MAX_LINE / 2))
    await Promise.resolve()
    chan.send('a'.repeat(MAX_LINE / 2))
    await Promise.resolve()
    chan.send(tail)
    expect(await line).toBe(Mark.LIMIT)
    input.close()
  })

  it('accepts the limit and resets for the next line', async () => {
    const [chan, input] = started(false)
    chan.send('a'.repeat(MAX_LINE) + '\nb\n')
    expect((await input.readline()).length).toBe(MAX_LINE + 1)
    expect(dec.decode((await input.readline()) as Uint8Array)).toBe('b\n')
    input.close()
  })

  it('takes its own line bound', async () => {
    const long = new FakeChannel()
    const wide = new FakeChannel()
    const tight = new ChannelInput(long.asChannel(), false, 4)
    const roomy = new ChannelInput(wide.asChannel(), false, 8)
    tight.start()
    roomy.start()
    long.send('aaaaaa\n')
    wide.send('aaaaaa\n')
    expect(await tight.readline()).toBe(Mark.LIMIT)
    expect(dec.decode((await roomy.readline()) as Uint8Array)).toBe('aaaaaa\n')
    tight.close()
    roomy.close()
  })

  it('bounds the terminal editor before it submits a line', async () => {
    const [chan, input] = started(true)
    chan.send('a'.repeat(MAX_TERMINAL_LINE))
    chan.send('b'.repeat(MAX_TERMINAL_LINE))
    chan.send('\x7fc\r')
    expect(dec.decode((await input.readline()) as Uint8Array)).toBe(
      'a'.repeat(MAX_TERMINAL_LINE - 1) + 'c\n',
    )
    input.close()
  })
})

it('keeps terminal input paused until its echo drains', async () => {
  const [chan, input] = started(true)
  vi.spyOn(chan, 'write').mockReturnValue(false)
  const resume = vi.spyOn(chan, 'resume')
  chan.send('line\r')
  expect(chan.pauses).toBe(1)
  expect(dec.decode((await input.readline()) as Uint8Array)).toBe('line\n')
  expect(resume).not.toHaveBeenCalled()
  chan.emit('drain')
  expect(resume).toHaveBeenCalledOnce()
  input.close()
})
