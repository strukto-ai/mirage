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

import { createHash } from 'node:crypto'
import {
  type ReadSpec,
  DEFAULT_READ_TTL,
  MountMode,
  ReadPolicy,
} from '@struktoai/mirage-core/types'

const FRESH: ReadSpec = { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL }
const BOUNDED: ReadSpec = { policy: ReadPolicy.BOUNDED, ttl: DEFAULT_READ_TTL }
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { S3Config } from '../vfs/s3/config.ts'
import { installS3Mock, type S3Mock } from '../vfs/s3/mock.ts'
import { S3VFS } from '../vfs/s3/s3.ts'
import { Workspace } from '../workspace.ts'

const BUCKET = 'wf-bucket'
const ENC = new TextEncoder()
const DEC = new TextDecoder()

// Non-empty suffix: the mock's ETag is then NOT md5(content), the way a
// multipart or SSE-KMS upload's is not, so a cache entry carrying the
// backend's token is distinguishable from a fabricated md5.
const SUFFIX = '-2'

function etagOf(data: string): string {
  return createHash('md5').update(data).digest('hex') + SUFFIX
}

function makeConfig(): S3Config {
  return {
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: 'fake',
    secretAccessKey: 'fake',
    forcePathStyle: true,
  }
}

function makeWorkspace(read: ReadSpec, mode: MountMode = MountMode.WRITE): Workspace {
  return new Workspace({ '/s3': new S3VFS(makeConfig()) }, { mode, read })
}

describe('object-store write fingerprint (mocked S3)', () => {
  let mock: S3Mock

  beforeAll(() => {
    mock = installS3Mock(undefined, { etagSuffix: SUFFIX })
  })

  afterEach(() => {
    // Only the store and the counters: `reset()` clears the registered
    // command behaviours too, which would leave the mock inert.
    for (const b of mock.store.allBuckets()) mock.store.objects(b).clear()
    mock.calls.clear()
  })

  afterAll(() => {
    mock.restore()
  })

  it('the write record carries the backend token', async () => {
    const ws = makeWorkspace(BOUNDED)
    try {
      await ws.shell('tee /s3/x.txt <<< hello')
      expect(ws.records.map((r) => [r.op, r.path, r.fingerprint])).toEqual([
        ['write', '/s3/x.txt', etagOf('hello\n')],
      ])
    } finally {
      await ws.close()
    }
  })

  it('a written path caches the backend token, not md5', async () => {
    // Holding a fabricated md5(content) is only right by accident on a simple-PUT
    // object, and never right on a multipart one.
    const ws = makeWorkspace(BOUNDED)
    try {
      await ws.shell('tee /s3/x.txt <<< hello')
      expect(await ws.cache.isFresh('/s3/x.txt', etagOf('hello\n'))).toBe(true)
      expect(
        await ws.cache.isFresh('/s3/x.txt', createHash('md5').update('hello\n').digest('hex')),
      ).toBe(false)
    } finally {
      await ws.close()
    }
  })

  it('ALWAYS reads a written path from cache', async () => {
    // The cost assertion. With the backend's token on the entry the
    // freshness probe matches and the read is served from cache; with the
    // no token it never matches a suffixed ETag, so every read evicts
    // and refetches.
    const ws = makeWorkspace(FRESH)
    try {
      await ws.shell('tee /s3/x.txt <<< hello')
      // Only the read is counted: tee probes its output before it writes.
      mock.calls.clear()
      const read = await ws.shell('cat /s3/x.txt')
      expect(DEC.decode(read.stdout)).toBe('hello\n')
      expect(mock.calls.get('HeadObject') ?? 0).toBe(1)
      expect(mock.calls.get('GetObject') ?? 0).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('read-then-write on one line keeps the read token', async () => {
    // `IOResult.merge` unions a line's reads and writes, and applyIo
    // caches the read's bytes. If those bytes were stamped with the
    // write's token the entry would read as fresh forever and the stale
    // bytes would serve; the next read must see the written content.
    mock.store.set(BUCKET, 'f.txt', ENC.encode('old\n'))
    const ws = makeWorkspace(FRESH)
    try {
      await ws.shell('cat /s3/f.txt && echo new | tee /s3/f.txt')
      const read = await ws.shell('cat /s3/f.txt')
      expect(DEC.decode(mock.store.get(BUCKET, 'f.txt') ?? new Uint8Array())).toBe('new\n')
      expect(DEC.decode(read.stdout)).toBe('new\n')
    } finally {
      await ws.close()
    }
  })

  it('write then truncate on one line does not pin stale bytes', async () => {
    // `truncate` records its own token but hands the cache no bytes, so
    // the entry would otherwise hold tee's content under truncate's
    // token and serve it for the life of the entry.
    const ws = makeWorkspace(FRESH)
    try {
      await ws.shell('echo hello | tee /s3/f.txt && truncate -s 2 /s3/f.txt')
      const read = await ws.shell('cat /s3/f.txt')
      expect(DEC.decode(mock.store.get(BUCKET, 'f.txt') ?? new Uint8Array())).toBe('he')
      expect(DEC.decode(read.stdout)).toBe('he')
    } finally {
      await ws.close()
    }
  })

  it('write then copy over it does not pin stale bytes', async () => {
    // `cp` replaces the path's entry in IOResult.writes with an empty
    // eviction marker while tee's write record stays the last one, so
    // the token would land on bytes it does not describe.
    mock.store.set(BUCKET, 'a.txt', ENC.encode('x\n'))
    const ws = makeWorkspace(FRESH)
    try {
      await ws.shell('echo x | tee /s3/f.txt && cp /s3/a.txt /s3/f.txt')
      const read = await ws.shell('cat /s3/f.txt')
      expect(DEC.decode(mock.store.get(BUCKET, 'f.txt') ?? new Uint8Array())).toBe('x\n')
      expect(DEC.decode(read.stdout)).toBe('x\n')
    } finally {
      await ws.close()
    }
  })

  interface WriteThenRead {
    stored: string
    served: string
    again: string
    downloads: number
  }

  /** Runs each line, then `cat /s3/f` twice, counting the first cat. */
  async function writeThenRead(
    lines: string[],
    read: ReadSpec,
    mode: MountMode = MountMode.WRITE,
  ): Promise<WriteThenRead> {
    const ws = makeWorkspace(read, mode)
    try {
      for (const line of lines) await ws.shell(line)
      mock.calls.clear()
      const first = await ws.shell('cat /s3/f')
      const downloads = mock.calls.get('GetObject') ?? 0
      const second = await ws.shell('cat /s3/f')
      return {
        stored: DEC.decode(mock.store.get(BUCKET, 'f') ?? new Uint8Array()),
        served: DEC.decode(first.stdout),
        again: DEC.decode(second.stdout),
        downloads,
      }
    } finally {
      await ws.close()
    }
  }

  it('a later unclaimed write drops the claimed bytes', async () => {
    // Equal lengths on purpose: the size guard cannot tell the two writes
    // apart, so only the provenance mark keeps aaaa from serving under
    // sed's token.
    const got = await writeThenRead(["echo aaaa | tee /s3/f; echo bbbb | sed -n 'w /s3/f'"], FRESH)
    expect(got.stored).toBe('bbbb\n')
    expect(got.served).toBe('bbbb\n')
    expect(got.again).toBe('bbbb\n')
  })

  it('a later runtime write drops the claimed bytes', async () => {
    // The in-process QuickJS runtime writes through RuntimeVFS, inside
    // the runtime command, which claims nothing.
    const got = await writeThenRead(
      [
        'echo aaaa | tee /s3/f; ' +
          `node -e "const f = std.open('/s3/f', 'w'); f.puts('bbbb\\n'); f.close()"`,
      ],
      FRESH,
      MountMode.EXEC,
    )
    expect(got.stored).toBe('bbbb\n')
    expect(got.served).toBe('bbbb\n')
    expect(got.again).toBe('bbbb\n')
  }, 120_000)

  it('chained in-place edits serve from cache', async () => {
    const got = await writeThenRead(
      ["printf 'a\\n' | tee /s3/f", 'sed -i s/a/b/ /s3/f && sed -i s/b/c/ /s3/f'],
      FRESH,
    )
    expect(got.stored).toBe('c\n')
    expect(got.served).toBe('c\n')
    expect(got.again).toBe('c\n')
    expect(got.downloads).toBe(0)
  })

  // Bounded: a tokenless leftover would serve here, where fresh would hide it
  // behind a re-read. A substitution hands only its stdout back, so its own
  // apply is the only one that decides.
  it.each([
    ['eval', `eval "echo aaaa | tee /s3/f; echo bbbb | sed -n 'w /s3/f'"`],
    ['substitution', `x=$(echo aaaa | tee /s3/f; echo bbbb | sed -n 'w /s3/f')`],
  ])('a nested line drops bytes a later unclaimed write replaced: %s', async (_, line) => {
    const got = await writeThenRead([line], BOUNDED)
    expect(got.stored).toBe('bbbb\n')
    expect(got.served).toBe('bbbb\n')
    expect(got.again).toBe('bbbb\n')
  })

  // A nested line applies against the records it added, so its own write
  // record vouches for tee's bytes and a fresh read downloads nothing.
  it.each([
    ['eval', "eval 'echo a | tee /s3/f'"],
    ['substitution', 'x=$(echo a | tee /s3/f)'],
  ])('a nested claimed write serves from cache: %s', async (_, line) => {
    const got = await writeThenRead([line], FRESH)
    expect(got.stored).toBe('a\n')
    expect(got.served).toBe('a\n')
    expect(got.downloads).toBe(0)
  })

  it('a nested read never takes a concurrent sibling read token', async () => {
    // The background substitution reads aaaa, then waits while the
    // foreground rewrites f and reads bbbb in its own substitution; a
    // sibling's read token must not label the older bytes.
    const waitFor = (path: string): string =>
      `for i in $(seq 500); do [ -e ${path} ] && break; sleep 0.01; done`
    const line =
      `x=$(cat /s3/f; touch /s3/go; ${waitFor('/s3/done')}) & ` +
      `${waitFor('/s3/go')}; echo bbbb | sed -n 'w /s3/f'; ` +
      'y=$(cat /s3/f); touch /s3/done; wait'
    const got = await writeThenRead(["echo aaaa | sed -n 'w /s3/f'", line], FRESH)
    expect(got.stored).toBe('bbbb\n')
    expect(got.served).toBe('bbbb\n')
    expect(got.again).toBe('bbbb\n')
  }, 30_000)

  // The oracle is the object the mock holds, so the landing order the
  // sleep sets is a margin, not what the assertion depends on.
  it.each([
    ['closed pipe', '{ sleep 0.2; echo aaaa; } | tee /s3/f | echo bbbb | tee /s3/f'],
    ['pipeline', '{ sleep 0.2; echo aaaa; } | tee /s3/f >/dev/null | echo bbbb | tee /s3/f'],
    [
      'xargs -P',
      "printf 'aaaa\\nbbbb\\n' | xargs -P2 -I{} sh -c 'test {} = aaaa && sleep 0.2; echo {} | tee /s3/f'",
    ],
    ['background', '{ sleep 0.2; echo aaaa | tee /s3/f; } & echo bbbb | tee /s3/f; wait'],
  ])('concurrent writers serve what the backend holds: %s', async (_name, line) => {
    const got = await writeThenRead([line], FRESH)
    expect(got.served).toBe(got.stored)
    expect(got.again).toBe(got.stored)
  })
})
