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

import type { QdrantClient } from '@qdrant/js-client-rest'
import { Accessor } from './base.ts'
import { loadOptionalPeer } from '../utils/optional_peer.ts'
import type { QdrantRow } from '../core/qdrant/types.ts'
import type { QdrantConfigResolved } from '../vfs/qdrant/config.ts'

type QdrantClientCtor = new (opts: {
  url?: string
  host?: string
  port?: number
  https?: boolean
  apiKey?: string
}) => QdrantClient

export class QdrantAccessor extends Accessor {
  readonly config: QdrantConfigResolved
  readonly indexesEnsured = new Set<string>()
  readonly searchCache = new Map<string, QdrantRow[]>()
  private opened: QdrantClient | null = null

  constructor(config: QdrantConfigResolved) {
    super()
    this.config = config
  }

  /** The mount's client, opened on first use. */
  async client(): Promise<QdrantClient> {
    if (this.opened === null) {
      const mod = (await loadOptionalPeer(
        () => import(/* @vite-ignore */ '@qdrant/js-client-rest'),
        { feature: 'QdrantVFS', packageName: '@qdrant/js-client-rest' },
      )) as { QdrantClient: QdrantClientCtor }
      const auth = this.config.apiKey !== null ? { apiKey: this.config.apiKey } : {}
      this.opened = new mod.QdrantClient(
        this.config.url !== null
          ? { url: this.config.url, ...auth }
          : { host: this.config.host, port: this.config.port, https: this.config.https, ...auth },
      )
    }
    return this.opened
  }
}
