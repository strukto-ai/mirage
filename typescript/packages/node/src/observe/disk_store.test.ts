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

import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Observer } from '@struktoai/mirage-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiskObserverStore } from './disk_store.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mirage-obs-disk-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function decode(files: Map<string, Uint8Array>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of files) out[k] = DEC.decode(v)
  return out
}

describe('DiskObserverStore', () => {
  it('append creates and extends', async () => {
    const store = new DiskObserverStore(join(root, 'obs'))
    await store.append('/d/s.jsonl', ENC.encode('a\n'))
    await store.append('/d/s.jsonl', ENC.encode('b\n'))
    expect(decode(await store.readAll())).toEqual({ '/d/s.jsonl': 'a\nb\n' })
  })

  it('write overwrites', async () => {
    const store = new DiskObserverStore(join(root, 'obs'))
    await store.append('/d/s.jsonl', ENC.encode('old\n'))
    await store.write('/d/s.jsonl', ENC.encode('new\n'))
    expect(decode(await store.readAll())).toEqual({ '/d/s.jsonl': 'new\n' })
  })

  it('readAll on a missing root returns empty', async () => {
    const store = new DiskObserverStore(join(root, 'missing'))
    expect((await store.readAll()).size).toBe(0)
  })

  it('readMatching filters by suffix', async () => {
    const store = new DiskObserverStore(join(root, 'obs'))
    await store.append('/d1/s1.jsonl', ENC.encode('a\n'))
    await store.append('/d1/s2.jsonl', ENC.encode('b\n'))
    await store.append('/d2/s1.jsonl', ENC.encode('c\n'))
    expect(decode(await store.readMatching('/s1.jsonl'))).toEqual({
      '/d1/s1.jsonl': 'a\n',
      '/d2/s1.jsonl': 'c\n',
    })
  })

  it('clear empties the store', async () => {
    const store = new DiskObserverStore(join(root, 'obs'))
    await store.append('/d/s.jsonl', ENC.encode('a\n'))
    await store.clear()
    expect((await store.readAll()).size).toBe(0)
  })

  it('backs an Observer round-trip', async () => {
    const obs = new Observer(new DiskObserverStore(join(root, 'obs')))
    await obs.logClear('s1', 'a')
    const events = await obs.events()
    const last = events[events.length - 1]
    expect(last?.type).toBe('clear')
    expect(last?.session).toBe('s1')
  })
  it('an unwritten root reads as no history', async () => {
    const store = new DiskObserverStore(join(root, 'never-written'))
    expect((await store.readAll()).size).toBe(0)
  })

  it('an unreadable directory raises instead of reading empty', async () => {
    // A partial recording that reports success is worse than a failure:
    // /.bash_history and the history builtin would show a truncated
    // recording with nothing to say it was truncated.
    const dir = join(root, 'obs')
    await new DiskObserverStore(dir).append('/d/s.jsonl', ENC.encode('a\n'))
    chmodSync(dir, 0o000)
    try {
      await expect(new DiskObserverStore(dir).readAll()).rejects.toThrow(/EACCES|EPERM/)
    } finally {
      chmodSync(dir, 0o755)
    }
  })
})
