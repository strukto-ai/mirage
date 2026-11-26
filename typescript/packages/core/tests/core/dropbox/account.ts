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

import { DropboxAccessor } from '../../../src/accessor/dropbox.ts'
import { DropboxTokenManager } from '../../../src/core/dropbox/client.ts'
import type { JsonValue } from '../../../src/types.ts'
import { KitRun } from '../../fixtures/kit_fake.ts'

const TOKEN = 'unit'

/** What Dropbox answers for an item. */
type DropboxAnswer = Record<string, JsonValue> & { name: string; rev: string; content_hash: string }

/**
 * One Dropbox account on the fake, and the writes a test arranges it by. The
 * fake answers a refresh with the refresh token as the access token, so the
 * accessor's calls land on the same account as `run`'s.
 */
export class DropboxAccount {
  readonly run: KitRun

  /** @param origin the Dropbox fake's origin. */
  constructor(origin: string) {
    this.run = new KitRun(origin, { Authorization: `Bearer ${TOKEN}` })
  }

  /** A Mirage accessor on this account, rooted at `rootPath` when given. */
  accessor(rootPath?: string): DropboxAccessor {
    const tokenManager = new DropboxTokenManager({
      clientId: 'c',
      clientSecret: 's',
      refreshToken: TOKEN,
      endpoint: this.run.url,
    })
    return new DropboxAccessor({ tokenManager, ...(rootPath === undefined ? {} : { rootPath }) })
  }

  /** Upload `data` at `path`, replacing a file there, and answer its metadata. */
  async put(path: string, data: Uint8Array): Promise<DropboxAnswer> {
    return this.run.call<DropboxAnswer>('POST', '/2/files/upload', {
      body: data,
      headers: {
        'Dropbox-API-Arg': apiArg({ path, mode: 'overwrite' }),
        'Content-Type': 'application/octet-stream',
      },
    })
  }

  /** Create a folder at `path` and answer its metadata. */
  async mkdir(path: string): Promise<DropboxAnswer> {
    const made = await this.run.call<{ metadata: DropboxAnswer }>(
      'POST',
      '/2/files/create_folder_v2',
      { json: { path } },
    )
    return made.metadata
  }

  /** The names the folder at `path` holds, sorted; '' is the account root. */
  async names(path = ''): Promise<string[]> {
    interface Page {
      entries: { name: string }[]
      cursor: string
      has_more: boolean
    }
    let page = await this.run.call<Page>('POST', '/2/files/list_folder', { json: { path } })
    const names = page.entries.map((entry) => entry.name)
    while (page.has_more) {
      page = await this.run.call<Page>('POST', '/2/files/list_folder/continue', {
        json: { cursor: page.cursor },
      })
      names.push(...page.entries.map((entry) => entry.name))
    }
    return names.sort()
  }

  /** The file at `path`'s content, downloaded as a client would. */
  async read(path: string): Promise<Uint8Array> {
    return this.run.read('/2/files/download', 'POST', {
      headers: { 'Dropbox-API-Arg': apiArg({ path }) },
    })
  }
}

// JSON for a header, every character past ASCII as a \u escape: a header
// value is a ByteString, so fetch refuses one that holds a wider character.
function apiArg(arg: JsonValue): string {
  return JSON.stringify(arg).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}
