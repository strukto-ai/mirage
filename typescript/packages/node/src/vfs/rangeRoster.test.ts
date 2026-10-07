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

import { describe, expect, it } from 'vitest'
import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { normalizeEmailConfig } from '../core/email/config.ts'
import { DiskVFS } from './disk/disk.ts'
import { EmailVFS } from './email/email.ts'
import { GridFSVFS } from './gridfs/gridfs.ts'
import { HfBucketsVFS } from './hf_buckets/hf_buckets.ts'
import { normalizeNextcloudConfig } from './nextcloud/config.ts'
import { NextcloudVFS } from './nextcloud/nextcloud.ts'
import { SSHVFS } from './ssh/ssh.ts'

// The node backends' half of core's vfs/rangeRoster.test.ts: who takes the
// window itself, and who leaves it to the read-and-slice fallback.
const NATIVE: [string, () => BaseVFS][] = [
  ['disk', () => new DiskVFS({ root: '/tmp' })],
  ['gridfs', () => new GridFSVFS({ uri: 'mongodb://h', database: 'd' })],
  ['hf_buckets', () => new HfBucketsVFS({ bucket: 'ns/store' })],
  [
    'nextcloud',
    () =>
      new NextcloudVFS(
        normalizeNextcloudConfig({ url: 'https://cloud.test/dav/', username: 'u', password: 'p' }),
      ),
  ],
  ['ssh', () => new SSHVFS({ host: 'h', username: 'u' })],
]

// Messages and attachments arrive already decoded from IMAP, so there is no
// remote window to ask for.
const SLICED: [string, () => BaseVFS][] = [
  [
    'email',
    () =>
      new EmailVFS(
        normalizeEmailConfig({
          imap_host: 'h',
          smtp_host: 'h',
          username: 'me@example.com',
          password: 'p',
        }),
      ),
  ],
]

describe('native read range roster', () => {
  it.each(NATIVE)('%s reads its own window', (_name, build) => {
    expect(build().readsRanges).toBe(true)
  })

  it.each(SLICED)('%s leaves the window to the fallback', (_name, build) => {
    expect(build().readsRanges).toBe(false)
  })
})
