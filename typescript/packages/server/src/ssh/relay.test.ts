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

import { createHash } from 'node:crypto'
import { type AddressInfo, type Socket, createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { relaySsh } from './relay.ts'

const BANNER = 'SSH-2.0-mirage\r\n'
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('relaySsh', () => {
  // The 101 and the server's first frame go out in one write, so they
  // reach the relay in one read, as they do when its process is too busy
  // to read between them.
  it('passes on a first frame that arrives with the upgrade', async () => {
    const sockets: Socket[] = []
    const server = createServer((socket) => {
      sockets.push(socket)
      socket.once('data', (request) => {
        const key = /sec-websocket-key: *(\S+)/i.exec(request.toString())?.[1] ?? ''
        const accept = createHash('sha1')
          .update(key + GUID)
          .digest('base64')
        const upgrade = [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '',
          '',
        ].join('\r\n')
        const frame = Buffer.concat([Buffer.from([0x82, BANNER.length]), Buffer.from(BANNER)])
        socket.write(Buffer.concat([Buffer.from(upgrade), frame]))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    let written = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written += String(chunk)
      return true
    })
    const relay = relaySsh(`ws://127.0.0.1:${String(port)}/`, {})
    await vi.waitFor(() => {
      expect(written).toBe(BANNER)
    })
    for (const socket of sockets) socket.destroy()
    await relay
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  })
})
