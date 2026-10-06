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

class FakeClient extends EventEmitter {
  constructor() {
    super()
    clients.push(this)
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
})
