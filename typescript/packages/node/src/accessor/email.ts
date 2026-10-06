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

import { Accessor } from '@struktoai/mirage-core/accessor/index'
import { loadOptionalPeer } from '@struktoai/mirage-core/utils/optional_peer'
import type { ImapFlow } from 'imapflow'
import type { EmailConfig } from '../core/email/config.ts'

export class EmailAccessor extends Accessor {
  readonly config: EmailConfig
  private clientPromise: Promise<ImapFlow> | null = null

  constructor(config: EmailConfig) {
    super()
    this.config = config
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
    if (this.clientPromise === null) {
      const pending: Promise<ImapFlow> = (async () => {
        const mod = await loadOptionalPeer(
          () =>
            import('imapflow') as unknown as Promise<{
              ImapFlow: typeof ImapFlow
            }>,
          { feature: 'EmailAccessor', packageName: 'imapflow' },
        )
        const client = new mod.ImapFlow({
          host: this.config.imapHost,
          port: this.config.imapPort,
          secure: this.config.useSsl,
          auth: { user: this.config.username, pass: this.config.password },
          logger: false,
        })
        const drop = (): void => {
          if (this.clientPromise === pending) this.clientPromise = null
        }
        client.on('error', drop)
        client.on('close', drop)
        await client.connect()
        return client
      })()
      this.clientPromise = pending
    }
    const current = this.clientPromise
    try {
      return await current
    } catch (err) {
      if (this.clientPromise === current) this.clientPromise = null
      throw err
    }
  }

  async close(): Promise<void> {
    if (this.clientPromise === null) return
    try {
      const c = await this.clientPromise
      await c.logout()
    } catch {
      // ignore — best-effort cleanup
    }
    this.clientPromise = null
  }
}
