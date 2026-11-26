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

import { BoxAccessor } from '../../../src/accessor/box.ts'
import { BoxTokenManager } from '../../../src/core/box/client.ts'
import type { JsonValue } from '../../../src/types.ts'
import { KitRun } from '../../fixtures/kit_fake.ts'

const TOKEN = 'unit'

/** What Box answers for an item by id. */
type BoxAnswer = Record<string, JsonValue> & {
  id: string
  modified_at: string
  path_collection: { total_count: number; entries: { type: string; id: string; name: string }[] }
}

/** One Box account on the fake, and the writes a test arranges it by. */
export class BoxAccount {
  readonly run: KitRun

  /** @param origin the Box fake's origin. */
  constructor(origin: string) {
    this.run = new KitRun(origin, { Authorization: `Bearer ${TOKEN}` })
  }

  /** A Mirage accessor on this account, rooted at `rootFolderId` when given. */
  accessor(rootFolderId?: string): BoxAccessor {
    const tokenManager = new BoxTokenManager({ accessToken: TOKEN, endpoint: this.run.url })
    return new BoxAccessor({
      tokenManager,
      ...(rootFolderId === undefined ? {} : { rootFolderId }),
    })
  }

  /** Create a folder in `parent` and answer its id. */
  async mkdir(name: string, parent = '0'): Promise<string> {
    const made = await this.run.call<{ id: string }>('POST', '/2.0/folders', {
      json: { name, parent: { id: parent } },
    })
    return made.id
  }

  /** Upload a new file into `parent` and answer its id. */
  async put(name: string, data: Uint8Array, parent = '0'): Promise<string> {
    const body = new FormData()
    body.append('attributes', JSON.stringify({ name, parent: { id: parent } }))
    body.append('file', new Blob([data as Uint8Array<ArrayBuffer>]), name)
    const made = await this.run.call<{ entries: { id: string }[] }>('POST', '/2.0/files/content', {
      body,
    })
    return made.entries[0]?.id ?? ''
  }

  /** Create a web link in `parent` and answer its id. */
  async webLink(name: string, parent = '0'): Promise<string> {
    const made = await this.run.call<{ id: string }>('POST', '/2.0/web_links', {
      json: { url: 'https://example.com', name, parent: { id: parent } },
    })
    return made.id
  }

  /** What Box answers for the file `id`. */
  async fileInfo(id: string): Promise<BoxAnswer> {
    return this.run.call<BoxAnswer>('GET', `/2.0/files/${id}`)
  }

  /** What Box answers for the folder `id`. */
  async folderInfo(id: string): Promise<BoxAnswer> {
    return this.run.call<BoxAnswer>('GET', `/2.0/folders/${id}`)
  }
}
