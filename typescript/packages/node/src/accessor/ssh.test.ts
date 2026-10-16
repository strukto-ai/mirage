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

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { SSHAccessor } from './ssh.ts'

const clients: FakeClient[] = []

// A command channel: its output is what the test emits on it, and close() is
// what the stream's return() must reach.
class FakeChannel extends EventEmitter {
  readonly stderr = { resume: vi.fn() }
  end = vi.fn()
  close = vi.fn(() => {
    this.emit('close')
  })
}

class FakeClient extends EventEmitter {
  readonly channels: FakeChannel[] = []
  // Each exec waits here until the test opens it, so a close can land first.
  readonly opens: (() => void)[] = []
  constructor() {
    super()
    clients.push(this)
  }
  exec(_command: string, done: (err: Error | undefined, channel: FakeChannel) => void): void {
    const channel = new FakeChannel()
    this.channels.push(channel)
    this.opens.push(() => {
      done(undefined, channel)
    })
  }
  connect(): void {
    setImmediate(() => this.emit('ready'))
  }
  setNoDelay = vi.fn()
  sftp(done: (err: Error | undefined, sftp: object) => void): void {
    done(undefined, { from: clients.length })
  }
  end(): void {
    this.emit('close')
  }
}

vi.mock('ssh2', () => ({ Client: FakeClient, default: { Client: FakeClient } }))

describe('SSHAccessor', () => {
  // The server or the network ending the connection leaves its SFTP channel
  // dead; the next call connects afresh. Mirrors test_ssh.py.
  it('reconnects after the connection closes', async () => {
    const accessor = new SSHAccessor({ host: 'unused', root: '/' })
    const first = await accessor.sftp()
    expect(await accessor.sftp()).toBe(first)
    clients.at(-1)?.emit('close')
    const second = await accessor.sftp()
    expect(second).not.toBe(first)
    expect(clients).toHaveLength(2)
    await accessor.close()
  })

  function last<T>(items: T[]): T {
    const item = items.at(-1)
    if (item === undefined) throw new Error('nothing made yet')
    return item
  }

  // The client the accessor connected, once its exec is waiting to open.
  async function execWaiting(accessor: SSHAccessor): Promise<FakeClient> {
    await accessor.sftp()
    const client = last(clients)
    for (let i = 0; i < 10 && client.opens.length === 0; i++) await new Promise(setImmediate)
    return client
  }

  async function opened(accessor: SSHAccessor): Promise<FakeChannel> {
    const client = await execWaiting(accessor)
    client.opens.shift()?.()
    await new Promise(setImmediate)
    return last(client.channels)
  }

  it('streams a command until its channel closes', async () => {
    const accessor = new SSHAccessor({ host: 'unused', root: '/' })
    const stream = accessor.runStream('tail -f x')
    const first = stream.next()
    const channel = await opened(accessor)
    expect(channel.end).toHaveBeenCalled()
    channel.emit('data', Buffer.from('a\n'))
    const step = await first
    expect(step.done === true ? null : new TextDecoder().decode(step.value)).toBe('a\n')
    const second = stream.next()
    channel.emit('close')
    expect((await second).done).toBe(true)
    await accessor.close()
  })

  it('closes the channel at once when a pull is waiting', async () => {
    const accessor = new SSHAccessor({ host: 'unused', root: '/' })
    const stream = accessor.runStream('tail -f x')
    const pending = stream.next()
    const channel = await opened(accessor)
    await stream.return?.()
    expect(channel.close).toHaveBeenCalledTimes(1)
    expect((await pending).done).toBe(true)
    await accessor.close()
  })

  it('closes a channel that opens after the stream was closed', async () => {
    const accessor = new SSHAccessor({ host: 'unused', root: '/' })
    const stream = accessor.runStream('tail -f x')
    const pending = stream.next()
    const client = await execWaiting(accessor)
    await stream.return?.()
    client.opens.shift()?.()
    expect((await pending).done).toBe(true)
    expect(client.channels.at(-1)?.close).toHaveBeenCalledTimes(1)
    await accessor.close()
  })
})
