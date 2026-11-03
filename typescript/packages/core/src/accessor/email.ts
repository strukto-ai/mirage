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

import { Accessor } from './index.ts'
import { DEFAULT_TIMEOUT } from '../core/api/constants.ts'
import { missingPeer } from '../utils/optional_peer.ts'
import type { ImapFlow } from 'imapflow'
import { judgeSocket } from '../io/web/network.ts'
import { currentRequest, type IncomingRequest } from '../io/web/request.ts'
import type { EmailConfig } from '../core/email/config.ts'

export class EmailAccessor extends Accessor {
  readonly config: EmailConfig
  // The client outside any incoming request, as on Node, where one serves
  // every call.
  private shared: Promise<ImapFlow> | null = null
  // An edge runtime cancels a socket with the request that opened it, so
  // each request there keeps its own client, let go with the request.
  private perRequest = new WeakMap<IncomingRequest, Promise<ImapFlow>>()

  constructor(config: EmailConfig) {
    super()
    this.config = config
  }

  private slot(request: IncomingRequest | null): Promise<ImapFlow> | null {
    return request === null ? this.shared : (this.perRequest.get(request) ?? null)
  }

  private setSlot(request: IncomingRequest | null, client: Promise<ImapFlow> | null): void {
    if (request === null) this.shared = client
    else if (client === null) this.perRequest.delete(request)
    else this.perRequest.set(request, client)
  }

  /**
   * The connected IMAP client, connecting on first use and again after the
   * last one failed. imapflow emits `error` when its socket times out, resets
   * or fails outside a command, and Node throws an `error` event nobody
   * listens for, which would end the process and every mount in it; the
   * listener keeps the failure on this client and drops it, as `close` does,
   * so the next access connects afresh instead of reusing a dead socket.
   */
  async getImap(): Promise<ImapFlow> {
    // An edge isolate opens the socket past its fetch guard, so the network
    // rule is asked here; elsewhere this is a no-op.
    judgeSocket(this.config.imapHost, this.config.imapPort)
    const request = currentRequest()
    let current = this.slot(request)
    if (current === null) {
      const pending: Promise<ImapFlow> = (async () => {
        const mod = (await import('imapflow').catch(
          missingPeer({ feature: 'EmailAccessor', packageName: 'imapflow' }),
        )) as unknown as { ImapFlow: typeof ImapFlow }
        const timeoutMs = (this.config.timeout ?? DEFAULT_TIMEOUT) * 1000
        const client = new mod.ImapFlow({
          host: this.config.imapHost,
          port: this.config.imapPort,
          secure: this.config.useSsl,
          auth: { user: this.config.username, pass: this.config.password },
          logger: false,
          connectionTimeout: timeoutMs,
          greetingTimeout: timeoutMs,
          socketTimeout: timeoutMs,
        })
        const drop = (): void => {
          if (this.slot(request) === pending) this.setSlot(request, null)
        }
        client.on('error', drop)
        client.on('close', drop)
        await client.connect()
        return client
      })()
      this.setSlot(request, pending)
      current = pending
    }
    try {
      return await current
    } catch (err) {
      if (this.slot(request) === current) this.setSlot(request, null)
      throw err
    }
  }

  override async close(): Promise<void> {
    // Another request's client is let go: closing it from here is I/O an
    // edge runtime refuses.
    const request = currentRequest()
    const current = this.slot(request)
    this.shared = null
    this.perRequest = new WeakMap()
    if (current === null) return
    try {
      const c = await current
      await c.logout()
    } catch {
      // ignore — best-effort cleanup
    }
  }
}
