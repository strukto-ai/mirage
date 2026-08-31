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

import type { Socket } from 'node:net'
import { SMTPServer } from 'smtp-server'
import type { SMTPServerSession } from 'smtp-server'
import { bindHost, checkName } from '../kit/typescript/index.ts'
import type { Runtime } from '../kit/typescript/index.ts'
import { INBOX, mailDomain, splitAddress, type C } from './config.ts'
import { queue } from './queue.ts'
import { appendMessage, canonicalName, createMailbox, mailboxOf, mailboxesOf } from './store.ts'

// Submission, not relay: a message is accepted, matched to a local account by
// its RCPT TO, and filed into that account's INBOX. Anything addressed outside
// the accounts this run holds is accepted and DROPPED, which is what every
// GreenMail deployment here relied on -- himalaya sends to `someone@example.com`
// in a test and nobody expects it delivered anywhere.
//
// The run comes from the SMTP PASSWORD, exactly as it does on the IMAP side, so
// a send and the read that checks for it land in one world.

function addressUser(raw: string): string {
  const at = raw.indexOf('<')
  const inner = at === -1 ? raw : raw.slice(at + 1, raw.indexOf('>', at))
  return inner.trim()
}

interface Auth {
  run: string
  tenant: string
}

const sessions = new WeakMap<SMTPServerSession, Auth>()

export function startSmtpServer(
  runtime: Runtime<C>,
  port: number,
): Promise<{ server: SMTPServer; port: number; close: () => Promise<void> }> {
  // Tracked for teardown, for the reason the IMAP side tracks its own.
  const open = new Set<Socket>()
  const server = new SMTPServer({
    authOptional: false,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onAuth: (auth, session, callback) => {
      const user = auth.username ?? ''
      const pass = auth.password ?? ''
      if (user === '' || pass === '') {
        callback(new Error('smtp: a username and password are required'))
        return
      }
      const address = splitAddress(user)
      if (address === null || address.domain !== mailDomain().toLowerCase()) {
        callback(new Error(`smtp: this server serves @${mailDomain()} only, not ${user}`))
        return
      }
      let run: string
      let tenant: string
      try {
        run = checkName('run', pass)
        tenant = checkName('tenant', address.local)
      } catch {
        callback(new Error('smtp: invalid credentials'))
        return
      }
      // An account with no mailboxes in this run is refused rather than
      // provisioned, for LOGIN's reason: a typo'd password must not become
      // a fresh empty world that accepts every send and delivers none.
      void mailboxesOf(runtime.pool.client(run), tenant)
        .then((boxes) => {
          if (boxes.length === 0) {
            callback(new Error(`smtp: no such account in this run: ${user}`))
            return
          }
          sessions.set(session, { run, tenant })
          callback(null, { user })
        })
        .catch((err: unknown) => {
          callback(err instanceof Error ? err : new Error(String(err)))
        })
    },
    onData: (stream, session, callback) => {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        const auth = sessions.get(session)
        if (auth === undefined) {
          callback(new Error('smtp: not authenticated'))
          return
        }
        const raw = Buffer.concat(chunks)
        // A recipient is matched by LOCAL PART inside this run, and only for
        // the one domain this server serves; a message to any other domain is
        // accepted and dropped, which is what a test sending to an outside
        // address expects and what GreenMail did.
        const domain = mailDomain().toLowerCase()
        const to = session.envelope.rcptTo
          .map((one) => splitAddress(addressUser(one.address)))
          .filter((one) => one !== null)
          .filter((one) => one.domain === domain)
          .map((one) => one.local)
        void queue
          .enqueue(auth.run, async () => {
            const db = runtime.pool.client(auth.run)
            for (const recipient of to) {
              // Delivery is by ACCOUNT, and the account is the tenant column,
              // so a message to an address this run never seeded is dropped
              // rather than filed under a tenant that does not exist. Creating
              // one here would make a typo'd recipient a new empty account that
              // LOGIN then accepts.
              if ((await mailboxOf(db, recipient, INBOX)) === null) continue
              const box = canonicalName(INBOX)
              if ((await mailboxOf(db, recipient, box)) === null) {
                await createMailbox(db, recipient, box)
              }
              await appendMessage(
                db,
                recipient,
                box,
                raw,
                [],
                runtime.state(auth.run).of(recipient).clock.nowMs(),
              )
            }
          })
          .then(
            () => {
              callback(null)
            },
            (err: unknown) => {
              callback(err instanceof Error ? err : new Error(String(err)))
            },
          )
      })
    },
  })
  return new Promise((resolve) => {
    server.server.on('connection', (socket: Socket) => {
      open.add(socket)
      socket.on('close', () => open.delete(socket))
    })
    server.listen(port, bindHost(), () => {
      const address = server.server.address()
      if (address === null || typeof address === 'string') throw new Error('smtp: no port')
      resolve({
        server,
        port: address.port,
        close: async () => {
          // Same trap as the IMAP side, one wrapper down: SMTPServer holds a
          // net.Server on `.server`, and that is where the open sockets are.
          // net.Server has no closeAllConnections -- that one is http.Server's
          // -- so the sockets are tracked and destroyed instead.
          await new Promise<void>((done) => {
            server.close(() => {
              done()
            })
            for (const socket of open) socket.destroy()
            open.clear()
          })
        },
      })
    })
  })
}
