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

import { KitRun } from '../../../../core/tests/fixtures/kit_fake.ts'

export const TOKEN = 'unit'

/**
 * One Dropbox account on the kit's Dropbox fake, and the writes a test
 * arranges it by. The fake answers a refresh with the refresh token as the
 * access token, so a mount configured with `TOKEN` lands on this account.
 */
export class DropboxAccount {
  readonly run: KitRun

  /** @param origin the Dropbox fake's origin. */
  constructor(origin: string) {
    this.run = new KitRun(origin, { Authorization: `Bearer ${TOKEN}` })
  }

  /** Upload `data` at `path`, replacing a file there. */
  async put(path: string, data: Uint8Array): Promise<void> {
    await this.run.call('POST', '/2/files/upload', {
      body: data,
      headers: {
        'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite' }),
        'Content-Type': 'application/octet-stream',
      },
    })
  }

  /** The bytes of the file at `path`; undefined if no file is there. */
  async content(path: string): Promise<Uint8Array | undefined> {
    const res = await this.run.request('POST', '/2/files/download', {
      headers: { 'Dropbox-API-Arg': JSON.stringify({ path }) },
    })
    const body = new Uint8Array(await res.arrayBuffer())
    if (res.status === 409) return undefined
    if (res.status !== 200) throw new Error(`download ${path} -> ${String(res.status)}`)
    return body
  }

  /** Delete the file or folder at `path`, as another client would. */
  async remove(path: string): Promise<void> {
    await this.run.call('POST', '/2/files/delete_v2', { json: { path } })
  }
}
