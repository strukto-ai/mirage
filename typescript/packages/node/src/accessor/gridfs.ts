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

import type { Db, MongoClient } from 'mongodb'
import { Accessor } from '@struktoai/mirage-core'
import { loadOptionalPeer } from '../optional_peer.ts'
import type { GridFSConfig } from '../resource/gridfs/config.ts'

interface MongoModule {
  MongoClient: new (uri: string) => MongoClient
}

export class GridFSAccessor extends Accessor {
  readonly config: GridFSConfig
  private clientPromise: Promise<MongoClient> | null = null

  constructor(config: GridFSConfig) {
    super()
    this.config = config
  }

  async client(): Promise<MongoClient> {
    this.clientPromise ??= this._connect()
    return this.clientPromise
  }

  async db(): Promise<Db> {
    const client = await this.client()
    return client.db(this.config.database)
  }

  private async _connect(): Promise<MongoClient> {
    const mod = await loadOptionalPeer(() => import('mongodb') as unknown as Promise<MongoModule>, {
      feature: 'GridFSResource',
      packageName: 'mongodb',
    })
    const client = new mod.MongoClient(this.config.uri)
    await client.connect()
    return client
  }

  async close(): Promise<void> {
    if (this.clientPromise === null) return
    const client = await this.clientPromise
    this.clientPromise = null
    await client.close()
  }
}
