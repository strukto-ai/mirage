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

// The server greets, answers each command and resets the socket 100 ms in: the
// uncaught `error` event that ended the process. Mirrors test_email.py.
function resettingServer(): Promise<{ server: net.Server; port: number; opened: () => number }> {
  let connections = 0
  const server = net.createServer((sock) => {
    connections += 1
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
    setTimeout(() => sock.resetAndDestroy(), 100)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo
      resolve({ server, port: address.port, opened: () => connections })
    })
  })
}

it('drops an IMAP client whose socket the server reset and connects afresh', async () => {
  const { server, port, opened } = await resettingServer()
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
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await accessor.getImap()).not.toBe(first)
    expect(opened()).toBe(2)
  } finally {
    await accessor.close()
    server.close()
  }
})
