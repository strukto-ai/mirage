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

import { Accessor, loadOptionalPeer } from '@struktoai/mirage-core'
import type { ImapFlow } from 'imapflow'
import type { EmailConfig } from '../core/email/config.ts'

export class EmailAccessor extends Accessor {
  readonly config: EmailConfig
  private clientPromise: Promise<ImapFlow> | null = null

  constructor(config: EmailConfig) {
    super()
    this.config = config
  }

  async getImap(): Promise<ImapFlow> {
    this.clientPromise ??= (async () => {
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
      await client.connect()
      return client
    })()
    try {
      return await this.clientPromise
    } catch (err) {
      this.clientPromise = null
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
