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
import { Channel } from '@struktoai/mirage-core'
import { SpillSink, ensureDirPath, type DirMaker, type SpillTarget } from './spill.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function fakeTarget(): { target: SpillTarget; files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const target: SpillTarget = {
    ensureDir: (d) => {
      dirs.add(d)
      return Promise.resolve()
    },
    write: (p, bytes) => {
      files.set(p, DEC.decode(bytes))
      return Promise.resolve()
    },
    append: (p, bytes) => {
      files.set(p, (files.get(p) ?? '') + DEC.decode(bytes))
      return Promise.resolve()
    },
  }
  return { target, files, dirs }
}

describe('SpillSink', () => {
  it('flushes the buffered stream on begin, then appends later chunks', async () => {
    const { target, files, dirs } = fakeTarget()
    const sink = new SpillSink(target, '/spill', 'job1')
    await sink.ingest(Channel.STDOUT, ENC.encode('one'))
    await sink.ingest(Channel.STDOUT, ENC.encode('two'))
    await sink.begin()
    await sink.ingest(Channel.STDOUT, ENC.encode('three'))
    expect(dirs.has('/spill')).toBe(true)
    expect(sink.stdoutPath).toBe('/spill/job1.stdout')
    expect(files.get('/spill/job1.stdout')).toBe('onetwothree')
  })

  it('opens a stderr file lazily when stderr first arrives after begin', async () => {
    const { target, files } = fakeTarget()
    const sink = new SpillSink(target, '/spill', 'job2')
    await sink.ingest(Channel.STDOUT, ENC.encode('out'))
    await sink.begin()
    // No stderr was buffered, so begin created no stderr file.
    expect(sink.stderrPath).toBeUndefined()
    await sink.ingest(Channel.STDERR, ENC.encode('boom'))
    expect(sink.stderrPath).toBe('/spill/job2.stderr')
    expect(files.get('/spill/job2.stderr')).toBe('boom')
  })

  it('leaves paths undefined and stops writing when a write fails', async () => {
    const failing: SpillTarget = {
      ensureDir: () => Promise.reject(new Error('read-only mount')),
      write: () => Promise.reject(new Error('read-only mount')),
      append: () => Promise.reject(new Error('read-only mount')),
    }
    const sink = new SpillSink(failing, '/spill', 'job3')
    await sink.ingest(Channel.STDOUT, ENC.encode('data'))
    await sink.begin()
    expect(sink.stdoutPath).toBeUndefined()
    // A later chunk must not throw once the sink has given up.
    await sink.ingest(Channel.STDOUT, ENC.encode('more'))
    expect(sink.stdoutPath).toBeUndefined()
  })

  it('stops writing once a reader reports it lost bytes', async () => {
    const { target, files } = fakeTarget()
    const sink = new SpillSink(target, '/spill', 'job4')
    await sink.ingest(Channel.STDOUT, ENC.encode('one'))
    await sink.begin()
    sink.disable()
    await sink.ingest(Channel.STDOUT, ENC.encode('two'))
    expect(sink.stdoutPath).toBeUndefined()
    expect(files.get('/spill/job4.stdout')).toBe('one')
  })
})

function fakeDirs(existing: string[] = []): { dirs: DirMaker; made: string[] } {
  const present = new Set(existing)
  const made: string[] = []
  const dirs: DirMaker = {
    exists: (p) => Promise.resolve(present.has(p)),
    mkdir: (p) => {
      made.push(p)
      present.add(p)
      return Promise.resolve()
    },
  }
  return { dirs, made }
}

describe('ensureDirPath', () => {
  it('creates every missing ancestor in order', async () => {
    const { dirs, made } = fakeDirs(['/data'])
    await ensureDirPath(dirs, '/data/spill/out')
    expect(made).toEqual(['/data/spill', '/data/spill/out'])
  })

  it('creates nothing when the directory is already there', async () => {
    const { dirs, made } = fakeDirs(['/data', '/data/spill'])
    await ensureDirPath(dirs, '/data/spill')
    expect(made).toEqual([])
  })

  it('accepts a refusal for a directory that now exists', async () => {
    // Two commands overrunning at once: both probe and see nothing,
    // one wins the mkdir and the loser is refused for the directory it
    // wanted. Losing that race must not cost it its spill.
    const present = new Set(['/data'])
    const dirs: DirMaker = {
      exists: (p) => Promise.resolve(present.has(p)),
      mkdir: (p) => {
        present.add(p)
        return Promise.reject(new Error(`EEXIST: ${p}`))
      },
    }
    await expect(ensureDirPath(dirs, '/data/spill')).resolves.toBeUndefined()
  })

  it('rethrows when the directory is still missing after the refusal', async () => {
    const dirs: DirMaker = {
      exists: () => Promise.resolve(false),
      mkdir: () => Promise.reject(new Error('read-only mount')),
    }
    await expect(ensureDirPath(dirs, '/data/spill')).rejects.toThrow('read-only mount')
  })
})
