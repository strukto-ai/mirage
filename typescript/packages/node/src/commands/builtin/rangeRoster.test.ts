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
import { DISK_IO } from './disk/io.ts'
import { GRIDFS_IO } from './gridfs/io.ts'
import { HF_IO } from './hf/io.ts'
import { NEXTCLOUD_IO } from './nextcloud/io.ts'
import { SSH_IO } from './ssh/io.ts'
import { EMAIL_IO } from './email/io.ts'

// The node half of the native-range roster; core pins its own in
// src/ops/rangeRoster.test.ts and python in tests/ops/test_read_range_roster.py.
const NATIVE = {
  disk: DISK_IO,
  gridfs: GRIDFS_IO,
  hf: HF_IO,
  nextcloud: NEXTCLOUD_IO,
  ssh: SSH_IO,
}

describe('native read range roster (node)', () => {
  it.each(Object.entries(NATIVE))('%s pushes the window down', (_name, io) => {
    expect(io.readRange).toBeDefined()
  })

  // Messages and attachments arrive already decoded from IMAP, so there is
  // no remote window to ask for.
  it('email leaves the slot empty', () => {
    expect(EMAIL_IO.readRange).toBeUndefined()
  })
})
