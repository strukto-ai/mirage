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
import { type ByteSource, type IOResult, materialize } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { followFlags, tailGeneric } from './tail.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/types.ts'
import { runWithCacheManager } from '../../../cache/context.ts'
import { RAMFileCacheStore } from '../../../cache/file/ram.ts'
import { CacheManager } from '../../../cache/manager.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function spec(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: '/d',
    resolved: true,
    resourcePath: mountKey(path, ''),
  })
}

function opts(flags: Record<string, string | boolean>, signal?: AbortSignal): CommandOpts {
  return {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: null,
    signal,
  } as unknown as CommandOpts
}

const bytesOf = (body: Uint8Array | null | undefined): Uint8Array => body ?? new Uint8Array()

// A fake mount whose files the test grows between polls.
class Growing {
  // A null entry is a directory.
  constructor(
    readonly data: Map<string, Uint8Array | null>,
    readonly sized = true,
  ) {}
  stat = (p: PathSpec): Promise<FileStat> => {
    const data = this.data.get(p.virtual)
    if (data === undefined) {
      const err = new Error('ENOENT') as Error & { code: string }
      err.code = 'ENOENT'
      return Promise.reject(err)
    }
    if (data === null) {
      return Promise.resolve(
        new FileStat({ name: p.virtual.split('/').pop() ?? '', type: FileType.DIRECTORY }),
      )
    }
    return Promise.resolve(
      new FileStat({
        name: p.virtual.split('/').pop() ?? '',
        size: this.sized ? data.byteLength : null,
        type: FileType.FILE,
      }),
    )
  }
  stream = async function* (this: Growing, p: PathSpec): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    yield bytesOf(this.data.get(p.virtual))
  }.bind(this)
  readRange = (p: PathSpec, offset: number, size: number): Promise<Uint8Array> =>
    Promise.resolve(bytesOf(this.data.get(p.virtual)).slice(offset, offset + size))
  set(path: string, text: string): void {
    this.data.set(path, ENC.encode(text))
  }
  append(path: string, text: string): void {
    const prior = this.data.get(path) ?? new Uint8Array()
    const added = ENC.encode(text)
    const out = new Uint8Array(prior.byteLength + added.byteLength)
    out.set(prior, 0)
    out.set(added, prior.byteLength)
    this.data.set(path, out)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function drainFor(
  source: AsyncIterable<Uint8Array>,
  ms: number,
  abort: AbortController,
): Promise<string> {
  const chunks: Uint8Array[] = []
  const drain = (async () => {
    for await (const chunk of source) chunks.push(chunk)
  })()
  await sleep(ms)
  abort.abort()
  await drain
  return chunks.map((c) => DEC.decode(c)).join('')
}

function followOpts(
  abort: AbortController,
  extra: Record<string, string | boolean> = {},
): CommandOpts {
  return opts({ follow: true, sleep_interval: '0.02', ...extra }, abort.signal)
}

describe('tail -f -s inf', () => {
  // GNU accepts `-s inf` (xstrtod passes and `0 <= inf`), so the value is
  // legal and the wait has to be genuinely indefinite. `setTimeout` holds a
  // 32-bit signed delay, so an unguarded `inf * 1000` makes Node warn and
  // clamp to 1ms, which polls the backend continuously and picks the growth
  // up -- the opposite of waiting. Python's `asyncio.sleep(inf)` waits, and
  // `test_follow_infinite_interval_never_polls` is its guard.
  it('never polls, so growth is not picked up, and aborts cleanly', async () => {
    const fs = new Growing(new Map())
    fs.set('/d/log', 'l1\nl2\n')
    const abort = new AbortController()
    const result = await tailGeneric(
      [spec('/d/log')],
      [],
      followOpts(abort, { sleep_interval: 'inf' }),
      fs.stream,
      fs.stat,
      fs.readRange,
    )
    const [stream, io] = result as [AsyncIterable<Uint8Array>, IOResult]
    const grower = (async () => {
      await sleep(40)
      fs.append('/d/log', 'l3\n')
      await sleep(40)
      fs.append('/d/log', 'l4\n')
    })()
    const text = await drainFor(stream, 250, abort)
    await grower
    expect(text).toBe('l1\nl2\n')
    expect(io.exitCode).toBe(0)
  })
})

describe('tail -f', () => {
  it('prints what a file gains and notes truncation', async () => {
    const fs = new Growing(new Map())
    fs.set('/d/log', 'l1\nl2\n')
    const abort = new AbortController()
    const result = await tailGeneric(
      [spec('/d/log')],
      [],
      followOpts(abort),
      fs.stream,
      fs.stat,
      fs.readRange,
    )
    const [stream, io] = result as [AsyncIterable<Uint8Array>, IOResult]
    const grower = (async () => {
      await sleep(60)
      fs.append('/d/log', 'l3\n')
      await sleep(60)
      fs.set('/d/log', 'z\n')
      await sleep(60)
      fs.append('/d/log', 'y\n')
    })()
    const text = await drainFor(stream, 350, abort)
    await grower
    expect(text).toBe('l1\nl2\nl3\nz\ny\n')
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('tail: /d/log: file truncated\n')
    expect(io.exitCode).toBe(0)
  })

  it('reads a size-unknown file whole every poll', async () => {
    const fs = new Growing(new Map(), false)
    fs.set('/d/log', 'a\n')
    const abort = new AbortController()
    const [stream, io] = (await tailGeneric(
      [spec('/d/log')],
      [],
      followOpts(abort),
      fs.stream,
      fs.stat,
      fs.readRange,
    )) as [AsyncIterable<Uint8Array>, IOResult]
    const grower = (async () => {
      await sleep(60)
      fs.append('/d/log', 'b\n')
      await sleep(60)
      fs.set('/d/log', 'z\n')
    })()
    const text = await drainFor(stream, 250, abort)
    await grower
    expect(text).toBe('a\nb\nz\n')
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('tail: /d/log: file truncated\n')
  })

  it('prints a repeated operand once per occurrence', async () => {
    const fs = new Growing(new Map())
    fs.set('/d/f', 'l1\n')
    const abort = new AbortController()
    const [stream] = (await tailGeneric(
      [spec('/d/f'), spec('/d/f')],
      [],
      followOpts(abort),
      fs.stream,
      fs.stat,
      fs.readRange,
    )) as [AsyncIterable<Uint8Array>, IOResult]
    const grower = (async () => {
      await sleep(60)
      fs.append('/d/f', 'l2\n')
    })()
    const text = await drainFor(stream, 200, abort)
    await grower
    expect(text).toBe(
      '==> /d/f <==\nl1\n\n==> /d/f <==\nl1\n\n==> /d/f <==\nl2\n\n==> /d/f <==\nl2\n',
    )
  })

  it('reads past the read-through cache while following', async () => {
    // A warm cache holds the body the last one-shot read saw; a follow
    // polls for exactly what that body does not have yet, so it reads
    // the backend itself, from the first print on.
    const fs = new Growing(new Map())
    fs.set('/s3/a.txt', 'l1\n')
    const cached = new PathSpec({
      virtual: '/s3/a.txt',
      directory: '/s3/',
      resolved: true,
      resourcePath: mountKey('/s3/a.txt', '/s3/'),
    })
    const cache = new RAMFileCacheStore()
    await cache.set('/s3/a.txt', ENC.encode('stale\n'))
    const manager = new CacheManager(cache, null, '/s3/', true)
    const abort = new AbortController()
    const [stream] = (await runWithCacheManager(manager, () =>
      tailGeneric([cached], [], followOpts(abort), fs.stream, fs.stat),
    )) as [AsyncIterable<Uint8Array>, IOResult]
    const grower = (async () => {
      await sleep(60)
      fs.append('/s3/a.txt', 'l2\n')
    })()
    const text = await drainFor(stream, 200, abort)
    await grower
    expect(text).toBe('l1\nl2\n')
  })

  it('-F waits for a directory to be replaced by a file', async () => {
    // Pinned on coreutils 9.7: `tail -F dir` reports the directory
    // without giving up, keeps the name, and announces `has become
    // accessible` once a file stands there.
    const fs = new Growing(new Map([['/d/dir', null]]))
    const abort = new AbortController()
    const [stream, io] = (await tailGeneric(
      [spec('/d/dir')],
      [],
      followOpts(abort, { F: true }),
      fs.stream,
      fs.stat,
      fs.readRange,
    )) as [AsyncIterable<Uint8Array>, IOResult]
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(
      'tail: /d/dir: Is a directory\ntail: /d/dir: cannot follow end of this type of file\n',
    )
    const grower = (async () => {
      await sleep(60)
      fs.set('/d/dir', 'born\n')
    })()
    const text = await drainFor(stream, 200, abort)
    await grower
    expect(text).toBe('born\n')
    expect(
      DEC.decode(io.stderr as Uint8Array).endsWith("tail: '/d/dir' has become accessible\n"),
    ).toBe(true)
  })

  it.each([true, false])(
    '-F waits out a directory that replaces the file (sized %s)',
    async (sized) => {
      // Pinned on coreutils 9.7: a directory standing where the followed
      // file was is `has been replaced with an untailable file`; -F
      // keeps the name and reads the file that replaces it from the
      // start, as `has become accessible`. A size-unknown backend must
      // not read the directory whole to find that out.
      const fs = new Growing(new Map([['/d/f', ENC.encode('a\n')]]), sized)
      const abort = new AbortController()
      const [stream, io] = (await tailGeneric(
        [spec('/d/f')],
        [],
        followOpts(abort, { F: true }),
        fs.stream,
        fs.stat,
        fs.readRange,
      )) as [AsyncIterable<Uint8Array>, IOResult]
      const grower = (async () => {
        await sleep(60)
        fs.data.set('/d/f', null)
        await sleep(60)
        fs.set('/d/f', 'b\n')
      })()
      const text = await drainFor(stream, 250, abort)
      await grower
      expect(text).toBe('a\nb\n')
      expect(DEC.decode(io.stderr as Uint8Array)).toBe(
        "tail: '/d/f' has been replaced with an untailable file\ntail: '/d/f' has become accessible\n",
      )
    },
  )

  it('--follow=name gives up on a directory that replaces the file', async () => {
    const fs = new Growing(new Map([['/d/f', ENC.encode('a\n')]]))
    const [stream, io] = (await tailGeneric(
      [spec('/d/f')],
      [],
      opts({ follow: 'name', sleep_interval: '0.02' }),
      fs.stream,
      fs.stat,
      fs.readRange,
    )) as [AsyncIterable<Uint8Array>, IOResult]
    const grower = (async () => {
      await sleep(60)
      fs.data.set('/d/f', null)
    })()
    const chunks: string[] = []
    for await (const chunk of stream) chunks.push(DEC.decode(chunk))
    await grower
    expect(chunks.join('')).toBe('a\n')
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(
      "tail: '/d/f' has been replaced with an untailable file; giving up on this name\ntail: no files remaining\n",
    )
    expect(io.exitCode).toBe(1)
  })

  it('a descriptor follow prints nothing while a directory stands there', async () => {
    // GNU keeps reading the descriptor it opened, which gains nothing.
    const fs = new Growing(new Map([['/d/f', ENC.encode('a\n')]]))
    const abort = new AbortController()
    const [stream, io] = (await tailGeneric(
      [spec('/d/f')],
      [],
      followOpts(abort),
      fs.stream,
      fs.stat,
      fs.readRange,
    )) as [AsyncIterable<Uint8Array>, IOResult]
    const grower = (async () => {
      await sleep(60)
      fs.data.set('/d/f', null)
    })()
    const text = await drainFor(stream, 200, abort)
    await grower
    expect(text).toBe('a\n')
    expect(io.stderr).toBeNull()
    expect(io.exitCode).toBe(0)
  })

  const givingUp: [Record<string, string | boolean>, string][] = [
    [{ follow: true }, '; giving up on this name'],
    [{ follow: 'descriptor', retry: true }, ''],
  ]
  it.each(givingUp)('gives up on a directory without a name retry (%o)', async (flags, suffix) => {
    const fs = new Growing(new Map([['/d/dir', null]]))
    const [stream, io] = (await tailGeneric(
      [spec('/d/dir')],
      [],
      opts({ sleep_interval: '0.02', ...flags }),
      fs.stream,
      fs.stat,
      fs.readRange,
    )) as [ByteSource | null, IOResult]
    expect(stream).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(
      DEC.decode(io.stderr as Uint8Array).endsWith(
        `tail: /d/dir: Is a directory\ntail: /d/dir: cannot follow end of this type of file${suffix}\ntail: no files remaining\n`,
      ),
    ).toBe(true)
  })

  it('--retry without follow warns and tails anyway', async () => {
    // Pinned on coreutils 9.7: the warning comes first, the tail is
    // printed as if --retry were not there, and the status is the
    // operands' own.
    const fs = new Growing(new Map())
    fs.set('/d/f', 'l1\nl2\n')
    const [stream, io] = (await tailGeneric(
      [spec('/d/f')],
      [],
      opts({ retry: true, n: '1' }),
      fs.stream,
      fs.stat,
      fs.readRange,
    )) as [ByteSource, IOResult]
    expect(DEC.decode(await materialize(stream))).toBe('l2\n')
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(
      'tail: warning: --retry ignored; --retry is useful only when following\n',
    )
    expect(io.exitCode).toBe(0)
  })

  it('switches headers as files take turns', async () => {
    const fs = new Growing(new Map())
    fs.set('/d/p', 'p\n')
    fs.set('/d/q', 'q\n')
    const abort = new AbortController()
    const [stream] = (await tailGeneric(
      [spec('/d/p'), spec('/d/q')],
      [],
      followOpts(abort),
      fs.stream,
      fs.stat,
      fs.readRange,
    )) as [AsyncIterable<Uint8Array>, IOResult]
    const grower = (async () => {
      await sleep(60)
      fs.append('/d/p', 'p2\n')
      await sleep(60)
      fs.append('/d/q', 'q2\n')
      await sleep(60)
      fs.append('/d/q', 'q3\n')
    })()
    const text = await drainFor(stream, 350, abort)
    await grower
    expect(text).toBe(
      '==> /d/p <==\np\n\n==> /d/q <==\nq\n\n==> /d/p <==\np2\n\n==> /d/q <==\nq2\nq3\n',
    )
  })

  it('with nothing to follow says so', async () => {
    const fs = new Growing(new Map())
    const abort = new AbortController()
    const [stream, io] = (await tailGeneric(
      [spec('/d/nope')],
      [],
      followOpts(abort),
      fs.stream,
      fs.stat,
      fs.readRange,
    )) as [null, IOResult]
    expect(stream).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr as Uint8Array).endsWith('tail: no files remaining\n')).toBe(true)
  })

  it('-F waits for a file to appear', async () => {
    const fs = new Growing(new Map())
    const abort = new AbortController()
    const [stream, io] = (await tailGeneric(
      [spec('/d/later')],
      [],
      opts({ F: true, sleep_interval: '0.02' }, abort.signal),
      fs.stream,
      fs.stat,
      fs.readRange,
    )) as [AsyncIterable<Uint8Array>, IOResult]
    const grower = (async () => {
      await sleep(60)
      fs.set('/d/later', 'born\n')
    })()
    const text = await drainFor(stream, 250, abort)
    await grower
    expect(text).toBe('born\n')
    expect(DEC.decode(io.stderr as Uint8Array)).toContain(
      "tail: '/d/later' has appeared;  following new file\n",
    )
  })

  it('--retry under a descriptor covers the initial open only', async () => {
    const fs = new Growing(new Map())
    const abort = new AbortController()
    const [stream, io] = (await tailGeneric(
      [spec('/d/later')],
      [],
      opts({ F: true, follow: 'descriptor', sleep_interval: '0.02' }, abort.signal),
      fs.stream,
      fs.stat,
      fs.readRange,
    )) as [AsyncIterable<Uint8Array>, IOResult]
    const first = DEC.decode(io.stderr as Uint8Array)
    expect(
      first.startsWith('tail: warning: --retry only effective for the initial open\ntail: '),
    ).toBe(true)
    expect(first.endsWith('No such file or directory\n')).toBe(true)
    const grower = (async () => {
      await sleep(60)
      fs.set('/d/later', 'born\n')
      await sleep(100)
      fs.data.delete('/d/later')
    })()
    const text = await drainFor(stream, 300, abort)
    await grower
    expect(text).toBe('born\n')
    expect(
      DEC.decode(io.stderr as Uint8Array).endsWith(
        "tail: '/d/later' has appeared;  following new file\n",
      ),
    ).toBe(true)
  })

  it.each([true, false])(
    '-F treats a read that finds nothing as inaccessible (sized %s)',
    async (sized) => {
      // A rotation can land between a poll's stat and its read; -F then
      // takes the same road as a failed stat, `has become inaccessible`,
      // and picks the name up again from the start when it is back.
      const fs = new Growing(new Map([['/d/f', ENC.encode('a\n')]]), sized)
      let trip = false
      const tripped = (): void => {
        if (!trip) return
        trip = false
        const err = new Error('ENOENT') as Error & { code: string }
        err.code = 'ENOENT'
        throw err
      }
      const stream = async function* (p: PathSpec): AsyncIterable<Uint8Array> {
        tripped()
        yield* fs.stream(p)
      }
      const readRange = (p: PathSpec, offset: number, size: number): Promise<Uint8Array> => {
        tripped()
        return fs.readRange(p, offset, size)
      }
      const abort = new AbortController()
      const [out, io] = (await tailGeneric(
        [spec('/d/f')],
        [],
        followOpts(abort, { F: true }),
        stream,
        fs.stat,
        readRange,
      )) as [AsyncIterable<Uint8Array>, IOResult]
      const grower = (async () => {
        await sleep(60)
        fs.set('/d/f', 'a\nb\n')
        trip = true
      })()
      const text = await drainFor(out, 300, abort)
      await grower
      expect(text).toBe('a\na\nb\n')
      expect(DEC.decode(io.stderr as Uint8Array)).toBe(
        "tail: '/d/f' has become inaccessible: No such file or directory\ntail: '/d/f' has appeared;  following new file\n",
      )
    },
  )

  it.each([{ F: true }, { f: true, retry: true }])(
    '--retry waits for an operand whose first read fails (%o)',
    async (flags) => {
      // The first read is the open (there is no handle to hold), so one
      // that fails after the operand's stat passed is a failed open:
      // reported as the stat's failure would have been, and waited for
      // under --retry, which covers the initial open under a descriptor
      // follow too.
      const fs = new Growing(new Map([['/d/f', ENC.encode('a\n')]]))
      let trip = true
      const stream = async function* (p: PathSpec): AsyncIterable<Uint8Array> {
        if (trip) {
          trip = false
          const err = new Error('ENOENT') as Error & { code: string }
          err.code = 'ENOENT'
          throw err
        }
        yield* fs.stream(p)
      }
      const abort = new AbortController()
      const [out, io] = (await tailGeneric(
        [spec('/d/f')],
        [],
        followOpts(abort, flags),
        stream,
        fs.stat,
        fs.readRange,
      )) as [AsyncIterable<Uint8Array>, IOResult]
      const text = await drainFor(out, 300, abort)
      expect(text).toBe('a\n')
      expect(io.exitCode).toBe(1)
      expect(DEC.decode(io.stderr as Uint8Array)).toBe(
        ('f' in flags ? 'tail: warning: --retry only effective for the initial open\n' : '') +
          "tail: /d/f: No such file or directory\ntail: '/d/f' has appeared;  following new file\n",
      )
    },
  )

  it('-f without --retry gives up on an operand whose first read fails', async () => {
    const fs = new Growing(new Map([['/d/f', ENC.encode('a\n')]]))
    const stream = (): AsyncIterable<Uint8Array> => {
      const err = new Error('ENOENT') as Error & { code: string }
      err.code = 'ENOENT'
      return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(err) }) }
    }
    const abort = new AbortController()
    const [out, io] = (await tailGeneric(
      [spec('/d/f')],
      [],
      followOpts(abort, { f: true }),
      stream,
      fs.stat,
      fs.readRange,
    )) as [AsyncIterable<Uint8Array>, IOResult]
    const text = await drainFor(out, 300, abort)
    expect(text).toBe('')
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(
      'tail: /d/f: No such file or directory\ntail: no files remaining\n',
    )
  })

  it('--follow=name gives up on a read that finds nothing', async () => {
    const fs = new Growing(new Map([['/d/f', ENC.encode('a\n')]]))
    let trip = false
    const readRange = (p: PathSpec, offset: number, size: number): Promise<Uint8Array> => {
      if (!trip) return fs.readRange(p, offset, size)
      trip = false
      const err = new Error('ENOENT') as Error & { code: string }
      err.code = 'ENOENT'
      return Promise.reject(err)
    }
    const abort = new AbortController()
    const [stream, io] = (await tailGeneric(
      [spec('/d/f')],
      [],
      followOpts(abort, { follow: 'name' }),
      fs.stream,
      fs.stat,
      readRange,
    )) as [AsyncIterable<Uint8Array>, IOResult]
    const grower = (async () => {
      await sleep(60)
      fs.set('/d/f', 'a\nb\n')
      trip = true
    })()
    const text = await drainFor(stream, 300, abort)
    await grower
    expect(text).toBe('a\n')
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(
      "tail: '/d/f' has become inaccessible: No such file or directory\ntail: no files remaining\n",
    )
    expect(io.exitCode).toBe(1)
  })

  it('--follow=name reports a file that vanishes', async () => {
    const fs = new Growing(new Map())
    fs.set('/d/gone', 'x\n')
    const abort = new AbortController()
    const [stream, io] = (await tailGeneric(
      [spec('/d/gone')],
      [],
      followOpts(abort, { follow: 'name' }),
      fs.stream,
      fs.stat,
      fs.readRange,
    )) as [AsyncIterable<Uint8Array>, IOResult]
    const grower = (async () => {
      await sleep(60)
      fs.data.delete('/d/gone')
    })()
    const text = await drainFor(stream, 250, abort)
    await grower
    expect(text).toBe('x\n')
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(
      "tail: '/d/gone' has become inaccessible: No such file or directory\ntail: no files remaining\n",
    )
    expect(io.exitCode).toBe(1)
  })

  it.each([
    [
      { follow: 'bogus' },
      "tail: invalid argument 'bogus' for '--follow'\nValid arguments are:\n  - 'descriptor'\n  - 'name'\nTry 'tail --help' for more information.\n",
    ],
    [{ follow: true, sleep_interval: 'bogus' }, "tail: invalid number of seconds: 'bogus'\n"],
  ])('refuses %o in GNU words', async (flags, stderr) => {
    const fs = new Growing(new Map())
    fs.set('/d/log', 'x\n')
    const [stream, io] = (await tailGeneric(
      [spec('/d/log')],
      [],
      opts(flags),
      fs.stream,
      fs.stat,
      fs.readRange,
    )) as [null, IOResult]
    expect(stream).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(stderr)
  })
})

// Both of tail's own flag refusals name the refused word through gnulib's
// quote(), so a byte outside 0x20-0x7e comes back escaped rather than
// interpolated raw. Every row measured against GNU coreutils 9.4 under
// `LC_ALL=C` with a raw `bytes` argv (`tail --follow=<w>`, `tail -s <w>`).
// Mirrors test_tail.py.
const QUOTED_WORDS: [string, string][] = [
  ['xé', 'x\\303\\251'],
  ['x\r', 'x\\r'],
  ['x\x01', 'x\\001'],
  ['x\x7f', 'x\\177'],
  ["x'", "x\\'"],
  ['x\\', 'x\\\\'],
]

describe('tail quotes the word it names', () => {
  it.each(QUOTED_WORDS)('escapes %j in the --follow clause', (value, escaped) => {
    expect(followFlags(new FlagView({ follow: value }, specOf('tail')))).toBe(
      `tail: invalid argument '${escaped}' for '--follow'\n` +
        "Valid arguments are:\n  - 'descriptor'\n  - 'name'\n" +
        "Try 'tail --help' for more information.\n",
    )
  })

  it.each(QUOTED_WORDS)('escapes %j in the -s clause', (value, escaped) => {
    expect(followFlags(new FlagView({ sleep_interval: `1${value}` }, specOf('tail')))).toBe(
      `tail: invalid number of seconds: '1${escaped}'\n`,
    )
  })

  it('quotes an empty -s value as the empty word', () => {
    expect(followFlags(new FlagView({ sleep_interval: '' }, specOf('tail')))).toBe(
      "tail: invalid number of seconds: ''\n",
    )
  })
})

// An EMPTY ARGMATCH value is `ambiguous`, not `invalid`: gnulib's argmatch
// matches on a prefix and `''` is a prefix of every candidate. Measured on
// coreutils 9.4: `tail --follow=` is
// `tail: ambiguous argument '' for '--follow'`, exit 1. Mirrors
// test_tail.py.
describe('tail --follow= is ambiguous, not invalid', () => {
  it('words the empty value as ambiguous', () => {
    const answer = followFlags(new FlagView({ follow: '' }, specOf('tail')))
    expect(typeof answer === 'string' ? answer.split('\n')[0] : answer).toBe(
      "tail: ambiguous argument '' for '--follow'",
    )
  })
})

// `-s` is `xstrtod` plus `0 <= s`, and the two halves answer separately.
// Every row measured on GNU coreutils 9.4 with a raw `bytes` argv
// (`tail -s <v> f`). Mirrors test_tail.py.
describe('tail -s reads exactly what strtod reads', () => {
  it.each([
    ' 1',
    '\r1',
    '\t1',
    '+1',
    '.5',
    '1.',
    '1e2',
    '+.5e1',
    '0x10',
    '0x1p4',
    '0x.8p1',
    '0x10.8',
    'inf',
    'infinity',
    'INF',
    '00',
  ])('accepts %j', (value) => {
    const answer = followFlags(new FlagView({ sleep_interval: value }, specOf('tail')))
    expect(typeof answer).not.toBe('string')
  })

  // TRAILING whitespace is not strtod's, and `0 <= nan` is false. Both
  // hosts accepted `tail -s $'1\r'` before this, because `Number()` and
  // python's `float()` strip trailing whitespace where `xstrtod` demands
  // the whole string be consumed.
  it.each([
    '1\r',
    '1 ',
    '1\t',
    '',
    '1_0',
    '1x',
    '0x',
    '1e',
    '1e+',
    '1,5',
    '.',
    '1.5.5',
    '0xp1',
    'inf inity',
    '-1',
    'nan',
    'NAN',
    'nan(x)',
  ])('refuses %j', (value) => {
    const answer = followFlags(new FlagView({ sleep_interval: value }, specOf('tail')))
    expect(typeof answer).toBe('string')
  })
})
