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
import { buildDaemonOpts } from './daemon.ts'

describe('buildDaemonOpts', () => {
  it('returns defaults when env is empty', () => {
    const { port, opts } = buildDaemonOpts({})
    expect(port).toBe(8765)
    expect(opts.idleGraceSeconds).toBe(30)
  })

  it('reads MIRAGE_DAEMON_PORT', () => {
    const { port } = buildDaemonOpts({ MIRAGE_DAEMON_PORT: '19999' })
    expect(port).toBe(19999)
  })

  it('reads MIRAGE_IDLE_GRACE_SECONDS', () => {
    const { opts } = buildDaemonOpts({ MIRAGE_IDLE_GRACE_SECONDS: '7' })
    expect(opts.idleGraceSeconds).toBe(7)
  })
})
