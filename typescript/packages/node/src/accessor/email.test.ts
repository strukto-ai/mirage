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

import net from 'node:net'
import { expect, it } from 'vitest'
import { EmailAccessor } from './email.ts'

// An IMAP server that answers every command and keeps its sockets, so the test
// resets them once the client is connected: the uncaught `error` event that
// ended the process. Mirrors test_email.py.
function imapServer(): Promise<{ server: net.Server; port: number; sockets: net.Socket[] }> {
  const sockets: net.Socket[] = []
  const server = net.createServer((sock) => {
    sockets.push(sock)
    sock.on('error', () => undefined)
    sock.write('* OK IMAP4rev1 ready\r\n')
    let buf = ''
    sock.on('data', (chunk) => {
      buf += String(chunk)
      let end = buf.indexOf('\r\n')
      while (end >= 0) {
        const [tag, cmd] = buf.slice(0, end).split(' ')
        buf = buf.slice(end + 2)
        if (cmd?.toUpperCase() === 'CAPABILITY') sock.write('* CAPABILITY IMAP4rev1\r\n')
        sock.write(`${tag ?? '*'} OK done\r\n`)
        end = buf.indexOf('\r\n')
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo
      resolve({ server, port: address.port, sockets })
    })
  })
}

it('drops an IMAP client whose socket the server reset and connects afresh', async () => {
  const { server, port, sockets } = await imapServer()
  const accessor = new EmailAccessor({
    imapHost: '127.0.0.1',
    imapPort: port,
    useSsl: false,
    smtpHost: '127.0.0.1',
    smtpPort: 9,
    username: 'u',
    password: 'p',
    maxMessages: 200,
    saveCopy: true,
    sentFolder: null,
  })
  try {
    const first = await accessor.getImap()
    const closed = new Promise((resolve) => first.once('close', resolve))
    for (const sock of sockets) sock.resetAndDestroy()
    await closed
    expect(await accessor.getImap()).not.toBe(first)
    expect(sockets).toHaveLength(2)
  } finally {
    await accessor.close()
    server.close()
  }
})
