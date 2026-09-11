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
import { Accessor } from '../../../accessor/base.ts'
import { JSON_NAME } from '../../../core/hierarchy/codec.ts'
import { Slot, Scope, makeDetectScope } from '../../../core/hierarchy/scope.ts'
import type { Searcher, SearchQuery } from '../../../core/hierarchy/search.ts'
import { ContentType, FileStat, FileType, PathSpec } from '../../../types.ts'
import { enoent } from '../../../utils/errors.ts'
import { stripSlash } from '../../../utils/slash.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import type { ByteSource, IOResult } from '../../../io/types.ts'
import { literalPushdownOperand } from '../grep_pushdown.ts'
import type { CommandIO } from './adapter.ts'
import { makeSearch } from './search.ts'

const SCOPES: readonly Scope[] = [
  new Scope({ kind: 'rooms', segments: ['rooms'], probed: false }),
  new Scope({ kind: 'room', segments: ['rooms', new Slot('room')] }),
  new Scope({
    kind: 'note',
    segments: ['rooms', new Slot('room'), new Slot('note', JSON_NAME)],
    leaf: true,
    filetype: ContentType.JSON,
  }),
]

const detectScope = makeDetectScope(SCOPES)

class FakeAccessor extends Accessor {}

const CONTENT = new TextEncoder().encode('x ada\ny\n')

function spec(mountPath: string): PathSpec {
  const key = stripSlash(mountPath)
  return new PathSpec({
    virtual: key !== '' ? `/h${mountPath}` : '/h',
    directory: '/h/',
    resourcePath: key,
  })
}

function makeIO(overrides: Partial<CommandIO<FakeAccessor>> = {}): CommandIO<FakeAccessor> {
  return {
    readdir: () => Promise.resolve([]),
    readBytes: () => Promise.resolve(CONTENT),
    // eslint-disable-next-line @typescript-eslint/require-await
    readStream: async function* () {
      yield CONTENT
    },
    stat: () =>
      Promise.resolve(
        new FileStat({
          name: 'a.json',
          type: FileType.FILE,
          content: ContentType.JSON,
          size: CONTENT.length,
        }),
      ),
    isMounted: () => true,
    local: false,
    ...overrides,
  }
}

const roomSearcher: Searcher<FakeAccessor> = (_accessor, match, query) =>
  Promise.resolve([`rooms/${match.slots.room ?? ''}:${query.pattern}`])

const emptySearcher: Searcher<FakeAccessor> = () => Promise.resolve([])

function opts(flags: CommandOpts['flags'] = {}): CommandOpts {
  return { stdin: null, flags, filetypeFns: null, cwd: '/' }
}

function unwrap(result: CommandFnResult): [ByteSource | null, IOResult] {
  if (result === null) throw new Error('command returned null')
  return result
}

async function drain(source: ByteSource | null): Promise<string> {
  if (source === null) return ''
  if (source instanceof Uint8Array) return new TextDecoder().decode(source)
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks.map((c) => new TextDecoder().decode(c)).join('')
}

describe('makeSearch', () => {
  it('answers a matched kind from its searcher', async () => {
    const search = makeSearch<FakeAccessor>('grep', detectScope, { room: roomSearcher }, makeIO(), {
      qualify: literalPushdownOperand,
    })
    const [out, result] = unwrap(
      await search(new FakeAccessor(), [spec('/rooms/red')], ['ada'], opts()),
    )
    expect(result.exitCode).toBe(0)
    expect(await drain(out)).toBe('rooms/red:ada\n')
  })

  it('answers an empty search with exit 1', async () => {
    const search = makeSearch<FakeAccessor>(
      'grep',
      detectScope,
      { room: emptySearcher },
      makeIO(),
      { qualify: literalPushdownOperand },
    )
    const [out, result] = unwrap(
      await search(new FakeAccessor(), [spec('/rooms/red')], ['ada'], opts()),
    )
    expect(result.exitCode).toBe(1)
    expect(await drain(out)).toBe('')
  })

  it('sends an unmatched kind to the generic scan', async () => {
    const search = makeSearch<FakeAccessor>('grep', detectScope, { room: roomSearcher }, makeIO(), {
      qualify: literalPushdownOperand,
    })
    const [out, result] = unwrap(
      await search(new FakeAccessor(), [spec('/rooms/red/a.json')], ['ada'], opts()),
    )
    expect(result.exitCode).toBe(0)
    expect(await drain(out)).toContain('x ada')
  })

  it('defers a shaping flag to the generic scan', async () => {
    const search = makeSearch<FakeAccessor>('grep', detectScope, { room: roomSearcher }, makeIO(), {
      qualify: literalPushdownOperand,
    })
    const [out, result] = unwrap(
      await search(new FakeAccessor(), [spec('/rooms/red/a.json')], ['ada'], opts({ v: true })),
    )
    expect(result.exitCode).toBe(0)
    const drained = await drain(out)
    expect(drained).toContain('y')
    expect(drained).not.toContain('x ada')
  })

  it('falls back to the whole read when the stream refuses before yielding', async () => {
    // A native stream that refuses a kind before yielding (mongodb's
    // documents-only stream on schema.json) must not fail the scan.
    const io = makeIO({
      // eslint-disable-next-line @typescript-eslint/require-await, require-yield
      readStream: async function* (_accessor, p) {
        throw enoent(p)
      },
    })
    const search = makeSearch<FakeAccessor>('grep', detectScope, { room: roomSearcher }, io, {
      qualify: literalPushdownOperand,
      stream: true,
    })
    const [out, result] = unwrap(
      await search(new FakeAccessor(), [spec('/rooms/red/a.json')], ['ada'], opts()),
    )
    expect(result.exitCode).toBe(0)
    expect(await drain(out)).toContain('x ada')
  })

  it('propagates a stream failure after data has flowed', async () => {
    const io = makeIO({
      // eslint-disable-next-line @typescript-eslint/require-await
      readStream: async function* (_accessor, p) {
        yield CONTENT
        throw enoent(p)
      },
    })
    const search = makeSearch<FakeAccessor>('grep', detectScope, { room: roomSearcher }, io, {
      qualify: literalPushdownOperand,
      stream: true,
    })
    await expect(
      (async () => {
        const [out] = unwrap(
          await search(new FakeAccessor(), [spec('/rooms/red/a.json')], ['ada'], opts()),
        )
        await drain(out)
      })(),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('probes existence before searching when guarded', async () => {
    const io = makeIO({ stat: (_accessor, p) => Promise.reject(enoent(p)) })
    const search = makeSearch<FakeAccessor>('grep', detectScope, { room: roomSearcher }, io, {
      qualify: literalPushdownOperand,
      guard: true,
    })
    await expect(
      search(new FakeAccessor(), [spec('/rooms/red')], ['ada'], opts()),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('carries the honored flags on the query', async () => {
    const seen: SearchQuery[] = []
    const recorder: Searcher<FakeAccessor> = (_accessor, _match, query) => {
      seen.push(query)
      return Promise.resolve(['line'])
    }
    const search = makeSearch<FakeAccessor>('grep', detectScope, { room: recorder }, makeIO(), {
      qualify: literalPushdownOperand,
    })
    await search(new FakeAccessor(), [spec('/rooms/red')], ['ada'], opts({ i: true }))
    expect(seen[0]?.ignoreCase).toBe(true)
    expect(seen[0]?.fixedString).toBe(false)
  })
})
