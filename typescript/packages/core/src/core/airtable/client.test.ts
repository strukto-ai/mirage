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

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RETRY,
  WRITE_RETRY,
  createComment,
  createRecords,
  deleteRecords,
  getRecord,
  listBases,
  listComments,
  listRecords,
  listTables,
  updateRecords,
} from './client.ts'
import {
  API,
  DONE_FORMULA,
  FEATURES,
  FakeAirtable,
  MODEL_NOT_FOUND,
  OPS,
  ROADMAP,
  TOKEN,
  makeAccessor,
} from '../../../tests/core/airtable/_test_util.ts'

const FIRST = 'rec00000000000001'

async function drain(batches: AsyncIterable<Record<string, unknown>[]>): Promise<number[]> {
  const sizes: number[] = []
  for await (const batch of batches) sizes.push(batch.length)
  return sizes
}

function names(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({ Name: `New ${String(i + 1)}` }))
}

function bodyOf(call: { body?: unknown }): Record<string, unknown> {
  return call.body as Record<string, unknown>
}

describe('airtable client', () => {
  it('vetoes only the billing cap', () => {
    expect(RETRY.retryable?.(429, '{"error": {"type": "RATE_LIMIT_REACHED"}}')).toBe(true)
    expect(RETRY.retryable?.(429, '{"error": {"type": "PUBLIC_API_BILLING_LIMIT_EXCEEDED"}}')).toBe(
      false,
    )
    expect(RETRY.minDelays?.[429]).toBe(30)
  })

  it('honors the configured base scope', async () => {
    const fake = new FakeAirtable()
    expect((await listBases(makeAccessor(fake))).map((b) => b.id)).toEqual([ROADMAP, OPS])
    expect((await listBases(makeAccessor(fake, { baseIds: [OPS] }))).map((b) => b.id)).toEqual([
      OPS,
    ])
  })

  it('names the call and the type on a bad token', async () => {
    const failure = listBases(makeAccessor(new FakeAirtable(), { token: 'wrong' }))
    await expect(failure).rejects.toThrow(
      'Airtable API error (GET /meta/bases): HTTP 401: AUTHENTICATION_REQUIRED: Authentication required',
    )
    await expect(failure).rejects.toMatchObject({
      status: 401,
      errorType: 'AUTHENTICATION_REQUIRED',
    })
  })

  it('returns the schema', async () => {
    const tables = await listTables(makeAccessor(new FakeAirtable()), ROADMAP)
    expect(tables.map((t) => t.id)).toEqual([FEATURES])
  })

  it('pages through every offset', async () => {
    const fake = new FakeAirtable()
    expect(await listRecords(makeAccessor(fake), ROADMAP, FEATURES)).toHaveLength(7)
    const calls = fake.recordCalls()
    expect(calls).toHaveLength(3)
    expect(calls[0]?.offset).toBeUndefined()
    expect(calls[1]?.offset).toBe('itrFakeIterator01/3')
    expect(calls.every((c) => c.pageSize === '100')).toBe(true)
  })

  it('sends maxRecords on the wire and stops the collector there', async () => {
    const fake = new FakeAirtable()
    const found = await listRecords(makeAccessor(fake), ROADMAP, FEATURES, { maxRecords: 2 })
    expect(found.map((r) => r.id)).toEqual(['rec00000000000001', 'rec00000000000002'])
    expect(fake.recordCalls()[0]?.maxRecords).toBe('2')
  })

  it('filters a view through the api', async () => {
    const found = await listRecords(makeAccessor(new FakeAirtable()), ROADMAP, FEATURES, {
      view: 'viwDone0000000001',
    })
    expect(found.map((r) => (r.fields as Record<string, unknown>).Priority)).toEqual([1, 3, 5, 7])
  })
})

describe('airtable client writes and comments', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends a formula on the wire', async () => {
    const fake = new FakeAirtable()
    const found = await listRecords(makeAccessor(fake), ROADMAP, FEATURES, {
      formula: DONE_FORMULA,
    })
    expect(found.map((r) => (r.fields as Record<string, unknown>).Priority)).toEqual([1, 3, 5, 7])
    expect(fake.recordCalls()[0]?.filterByFormula).toBe(DONE_FORMULA)
  })

  it('takes a table name as well as its id', async () => {
    expect(await listRecords(makeAccessor(new FakeAirtable()), ROADMAP, 'Features')).toHaveLength(7)
  })

  it('reads one record by id', async () => {
    const accessor = makeAccessor(new FakeAirtable())
    const record = await getRecord(accessor, ROADMAP, FEATURES, FIRST)
    expect((record.fields as Record<string, unknown>).Name).toBe('Feature 1')
    const missing = getRecord(accessor, ROADMAP, FEATURES, 'recZZZZZZZZZZZZZZ')
    await expect(missing).rejects.toThrow(
      `Airtable API error (GET /${ROADMAP}/${FEATURES}/recZZZZZZZZZZZZZZ): HTTP 403: ` +
        `INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND: ${MODEL_NOT_FOUND}`,
    )
    await expect(missing).rejects.toMatchObject({ status: 403, notFound: true })
  })

  it('creates ten records to a request', async () => {
    const fake = new FakeAirtable()
    expect(await drain(createRecords(makeAccessor(fake), ROADMAP, FEATURES, names(23)))).toEqual([
      10, 10, 3,
    ])
    const bodies = fake.writeCalls().map(bodyOf)
    expect(bodies.map((b) => (b.records as unknown[]).length)).toEqual([10, 10, 3])
    expect((bodies[0]?.records as unknown[])[0]).toEqual({ fields: { Name: 'New 1' } })
    expect(bodies.every((b) => !('typecast' in b))).toBe(true)
    expect(fake.records[FEATURES]).toHaveLength(30)
  })

  it('sends its write bodies as JSON', async () => {
    const fake = new FakeAirtable()
    const bare = await fake.fetch(`${API}/${ROADMAP}/${FEATURES}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: '{"records": [{"fields": {}}]}',
    })
    expect([bare.status, ((await bare.json()) as { error: { type: string } }).error.type]).toEqual([
      422,
      'INVALID_REQUEST_BODY',
    ])
    await drain(createRecords(makeAccessor(fake), ROADMAP, FEATURES, names(1)))
    expect(fake.records[FEATURES]).toHaveLength(8)
  })

  it('sends typecast as a body key', async () => {
    const fake = new FakeAirtable()
    const accessor = makeAccessor(fake)
    await drain(createRecords(accessor, ROADMAP, FEATURES, names(1), { typecast: true }))
    await drain(
      updateRecords(accessor, ROADMAP, FEATURES, [[FIRST, { Priority: 9 }]], { typecast: true }),
    )
    expect(fake.writeCalls().map((c) => bodyOf(c).typecast)).toEqual([true, true])
  })

  it('patches ten records to a request', async () => {
    const fake = new FakeAirtable()
    const ids = (fake.records[FEATURES] ?? []).map((r) => String(r.id))
    const updates = [...ids, ...ids]
      .slice(0, 12)
      .map((id): [string, Record<string, unknown>] => [id, { Priority: 0 }])
    expect(await drain(updateRecords(makeAccessor(fake), ROADMAP, FEATURES, updates))).toEqual([
      10, 2,
    ])
    const calls = fake.writeCalls()
    expect(calls.map((c) => c.kind)).toEqual(['update', 'update'])
    expect((bodyOf(calls[0] ?? {}).records as unknown[])[0]).toEqual({
      id: FIRST,
      fields: { Priority: 0 },
    })
    expect((fake.records[FEATURES]?.[0]?.fields as Record<string, unknown>).Name).toBe('Feature 1')
  })

  it('deletes by records[] ten to a request', async () => {
    const fake = new FakeAirtable()
    const accessor = makeAccessor(fake)
    await drain(createRecords(accessor, ROADMAP, FEATURES, names(5)))
    const ids = (fake.records[FEATURES] ?? []).map((r) => String(r.id))
    expect(await drain(deleteRecords(accessor, ROADMAP, FEATURES, ids))).toEqual([10, 2])
    const deletes = fake.writeCalls().filter((c) => c.kind === 'delete')
    expect(deletes.map((d) => d.params.records)).toEqual([
      ids.slice(0, 10).join(','),
      ids.slice(10).join(','),
    ])
    expect(fake.records[FEATURES]).toEqual([])
  })

  it('stops a failed write after what landed', async () => {
    const fake = new FakeAirtable()
    const landed: number[] = []
    const rows = [...names(10), { Nope: 1 }, ...names(2)]
    const failure = (async () => {
      for await (const batch of createRecords(makeAccessor(fake), ROADMAP, FEATURES, rows)) {
        landed.push(batch.length)
      }
    })()
    await expect(failure).rejects.toMatchObject({ errorType: 'UNKNOWN_FIELD_NAME' })
    expect(landed).toEqual([10])
    expect(fake.writeCalls()).toHaveLength(2)
    expect(fake.records[FEATURES]).toHaveLength(17)
  })

  it('never retries a 503 on a write', async () => {
    const fake = new FakeAirtable({ faults: { 1: [503, 'SERVICE_UNAVAILABLE'] } })
    await expect(
      drain(createRecords(makeAccessor(fake), ROADMAP, FEATURES, names(1))),
    ).rejects.toMatchObject({ status: 503 })
    expect(fake.writeCalls()).toHaveLength(1)
  })

  it('waits out a 429 and retries the write', async () => {
    vi.useFakeTimers()
    const fake = new FakeAirtable({ faults: { 1: [429, 'RATE_LIMIT_REACHED'] } })
    const done = drain(createRecords(makeAccessor(fake), ROADMAP, FEATURES, names(1)))
    await vi.advanceTimersByTimeAsync(29_000)
    expect(fake.writeCalls()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await done).toEqual([1])
    expect(fake.writeCalls()).toHaveLength(2)
  })

  it('retries only the 429 on a write', () => {
    expect([...WRITE_RETRY.statuses]).toEqual([429])
    expect(WRITE_RETRY.minDelays?.[429]).toBe(30)
    expect(
      WRITE_RETRY.retryable?.(429, '{"error": {"type": "PUBLIC_API_BILLING_LIMIT_EXCEEDED"}}'),
    ).toBe(false)
    expect(RETRY.statuses.has(502) && RETRY.statuses.has(503)).toBe(true)
  })

  it('pages comments newest first', async () => {
    const fake = new FakeAirtable()
    const accessor = makeAccessor(fake)
    for (const n of [0, 1, 2]) {
      await createComment(accessor, ROADMAP, FEATURES, FIRST, `note ${String(n)}`)
    }
    const comments = await listComments(accessor, ROADMAP, FEATURES, FIRST)
    expect(comments.map((c) => c.text)).toEqual([
      'note 2',
      'note 1',
      'note 0',
      'Shipped it.',
      'Looks good.',
    ])
    const pages = fake.calls.filter((c) => c.kind === 'comments')
    expect(pages).toHaveLength(2)
    expect(pages[1]?.params.offset).toBe('itrFakeIterator01/3')
  })

  it('posts only the text of a comment', async () => {
    const fake = new FakeAirtable()
    const made = await createComment(makeAccessor(fake), ROADMAP, FEATURES, FIRST, 'hello')
    expect(made.text).toBe('hello')
    expect((made.author as Record<string, unknown>).email).toBe('ada@example.com')
    expect(fake.writeCalls()[0]?.body).toEqual({ text: 'hello' })
  })

  it('paces every request under its base', async () => {
    const accessor = makeAccessor(new FakeAirtable())
    const keys: string[] = []
    const acquire = accessor.limiter.acquire.bind(accessor.limiter)
    vi.spyOn(accessor.limiter, 'acquire').mockImplementation((key: string) => {
      keys.push(key)
      return acquire(key)
    })
    const second = 'rec00000000000002'
    await drain(createRecords(accessor, ROADMAP, FEATURES, names(11)))
    await drain(updateRecords(accessor, ROADMAP, FEATURES, [[FIRST, { Priority: 2 }]]))
    await drain(deleteRecords(accessor, ROADMAP, FEATURES, [FIRST]))
    await getRecord(accessor, ROADMAP, FEATURES, second)
    await createComment(accessor, ROADMAP, FEATURES, second, 'x')
    await listComments(accessor, ROADMAP, FEATURES, second)
    expect(keys).toEqual(Array.from({ length: 7 }, () => ROADMAP))
  })
})
