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
import { ContentType, FileStat, FileType } from '../../../types.ts'
import type { CommandIO } from './adapter.ts'
import { makeGenericCommands } from './factory.ts'

function makeOps(overrides: Partial<CommandIO> = {}): CommandIO {
  return {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    readStream: async function* () {},
    readBytes: () => Promise.resolve(new Uint8Array()),
    readdir: () => Promise.resolve([]),
    stat: () =>
      Promise.resolve(new FileStat({ name: 'x', type: FileType.FILE, content: ContentType.TEXT })),
    isMounted: () => true,
    local: true,
    ...overrides,
  }
}

describe('makeGenericCommands', () => {
  it('emits read/metadata commands from the catalog', () => {
    const names = new Set(makeGenericCommands('ram', makeOps()).map((c) => c.name))
    expect(names.has('cat')).toBe(true)
    expect(names.has('ls')).toBe(true)
    expect(names.has('stat')).toBe(true)
  })

  it('skips overridden commands', () => {
    const names = makeGenericCommands('ram', makeOps(), {
      overrides: new Set(['stat', 'du']),
    }).map((c) => c.name)
    expect(names).not.toContain('stat')
    expect(names).not.toContain('du')
    expect(names).toContain('cat')
  })

  it('attaches aggregate only for local backends', () => {
    const local = makeGenericCommands('ram', makeOps({ local: true })).find((c) => c.name === 'cat')
    const remote = makeGenericCommands('s3', makeOps({ local: false })).find(
      (c) => c.name === 'cat',
    )
    expect(local?.aggregate).not.toBeNull()
    expect(remote?.aggregate).toBeNull()
  })

  it('skips a command whose required op the backend lacks', () => {
    // A write op alone is not enough: rmdir needs rmdir, truncate needs
    // truncate. Registering them anyway yields a command that can only throw.
    const names = new Set(
      makeGenericCommands('hf_buckets', makeOps({ write: () => Promise.resolve() })).map(
        (c) => c.name,
      ),
    )
    expect(names.has('tee')).toBe(true)
    expect(names.has('rmdir')).toBe(false)
    expect(names.has('truncate')).toBe(false)
  })

  it('registers ops-gated commands once the backend supplies them', () => {
    const names = new Set(
      makeGenericCommands(
        'disk',
        makeOps({
          write: () => Promise.resolve(),
          rmdir: () => Promise.resolve(),
          truncate: () => Promise.resolve(),
        }),
      ).map((c) => c.name),
    )
    expect(names.has('rmdir')).toBe(true)
    expect(names.has('truncate')).toBe(true)
  })

  it('registers shuf on a read-only backend', () => {
    // Only `shuf -o` writes, so a backend with no write op still serves it.
    const shuf = makeGenericCommands('chroma', makeOps()).find((c) => c.name === 'shuf')
    expect(shuf).toBeDefined()
    expect(shuf?.write).toBe(false)
  })
})
