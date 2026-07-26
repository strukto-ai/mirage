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

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./_client.ts', () => ({
  fetchColumns: vi.fn(),
  fetchPrimaryKey: vi.fn(),
  fetchForeignKeys: vi.fn(),
  fetchTableComment: vi.fn(),
  fetchColumnComments: vi.fn(),
  fetchEnumColumns: vi.fn(),
  fetchColumnStats: vi.fn(),
}))

import { PostgresAccessor } from '../../accessor/postgres.ts'
import { resolvePostgresConfig } from '../../resource/postgres/config.ts'
import type { ColumnInfo, ForeignKey } from './_client.ts'
import * as _client from './_client.ts'
import type { PgDriver } from './_driver.ts'
import {
  buildColumnEntry,
  buildEntitySemanticJson,
  buildRelationships,
  classifyColumn,
} from './semantic.ts'

const SAMPLE_VALUES_LIMIT = 10

const COLUMNS: ColumnInfo[] = [
  { name: 'order_id', type: 'integer', nullable: false },
  { name: 'customer_id', type: 'integer', nullable: true },
  { name: 'status', type: 'USER-DEFINED', nullable: true },
  { name: 'channel', type: 'text', nullable: true },
  { name: 'total_amount', type: 'numeric', nullable: true },
  { name: 'placed_at', type: 'timestamp with time zone', nullable: true },
]

const FOREIGN_KEYS: ForeignKey[] = [
  {
    columns: ['customer_id'],
    references: { schema: 'public', table: 'customers', columns: ['id'] },
  },
]

const STUB_DRIVER: PgDriver = {
  query: () => Promise.resolve({ rows: [], rowCount: 0 }),
  close: () => Promise.resolve(),
}

function makeAccessor(): PostgresAccessor {
  return new PostgresAccessor(
    STUB_DRIVER,
    resolvePostgresConfig({ dsn: 'postgres://localhost/db' }),
  )
}

function primeClient(): void {
  vi.mocked(_client.fetchColumns).mockResolvedValue(COLUMNS)
  vi.mocked(_client.fetchPrimaryKey).mockResolvedValue(['order_id'])
  vi.mocked(_client.fetchForeignKeys).mockResolvedValue(FOREIGN_KEYS)
  vi.mocked(_client.fetchTableComment).mockResolvedValue('Customer orders.')
  vi.mocked(_client.fetchColumnComments).mockResolvedValue(
    new Map([['total_amount', 'Order total in USD.']]),
  )
  vi.mocked(_client.fetchEnumColumns).mockResolvedValue(
    new Map([['status', { type: 'order_status', labels: ['pending', 'shipped', 'cancelled'] }]]),
  )
  vi.mocked(_client.fetchColumnStats).mockResolvedValue(
    new Map([
      ['channel', { n_distinct: 3, most_common_vals: ['web', 'retail', 'partner'] }],
      ['total_amount', { n_distinct: -1, most_common_vals: [] }],
    ]),
  )
}

describe('classifyColumn', () => {
  it('keeps a key column a dimension even when numeric', () => {
    expect(classifyColumn('order_id', 'integer', new Set(['order_id']))).toBe('dimensions')
  })
  it('classifies a numeric non-key as a fact', () => {
    expect(classifyColumn('total_amount', 'numeric', new Set())).toBe('facts')
  })
  it('classifies a timestamp as a time dimension', () => {
    expect(classifyColumn('placed_at', 'timestamp with time zone', new Set())).toBe(
      'time_dimensions',
    )
  })
  it('classifies text as a dimension', () => {
    expect(classifyColumn('channel', 'text', new Set())).toBe('dimensions')
  })
})

describe('buildColumnEntry', () => {
  it('omits absent metadata', () => {
    const entry = buildColumnEntry(
      { name: 'channel', type: 'text', nullable: true },
      undefined,
      undefined,
      undefined,
    )
    expect(entry).toEqual({ name: 'channel', expr: 'channel', data_type: 'text' })
  })

  it('uses the enum type and labels', () => {
    const entry = buildColumnEntry(
      { name: 'status', type: 'USER-DEFINED', nullable: true },
      undefined,
      { type: 'order_status', labels: ['pending', 'shipped'] },
      undefined,
    )
    expect(entry.data_type).toBe('order_status')
    expect(entry.is_enum).toBe(true)
    expect(entry.sample_values).toEqual(['pending', 'shipped'])
  })

  it('takes sample values from stats', () => {
    const entry = buildColumnEntry(
      { name: 'channel', type: 'text', nullable: true },
      undefined,
      undefined,
      { n_distinct: 3, most_common_vals: ['web', 'retail'] },
    )
    expect(entry.sample_values).toEqual(['web', 'retail'])
    expect(entry.is_enum).toBeUndefined()
  })

  it('skips sample values when stats are empty', () => {
    const entry = buildColumnEntry(
      { name: 'total_amount', type: 'numeric', nullable: true },
      undefined,
      undefined,
      { n_distinct: -1, most_common_vals: [] },
    )
    expect(entry.sample_values).toBeUndefined()
  })

  it('caps sample values at the limit', () => {
    const many = Array.from({ length: SAMPLE_VALUES_LIMIT + 5 }, (_, i) => String(i))
    const entry = buildColumnEntry(
      { name: 'channel', type: 'text', nullable: true },
      undefined,
      undefined,
      { n_distinct: 15, most_common_vals: many },
    )
    expect(entry.sample_values).toHaveLength(SAMPLE_VALUES_LIMIT)
  })
})

describe('buildRelationships', () => {
  it('pairs foreign-key columns', () => {
    expect(buildRelationships(FOREIGN_KEYS, 'public', 'orders')).toEqual([
      {
        left_table: 'public.orders',
        right_table: 'public.customers',
        relationship_columns: [{ left_column: 'customer_id', right_column: 'id' }],
      },
    ])
  })

  it('is empty without foreign keys', () => {
    expect(buildRelationships([], 'public', 'orders')).toEqual([])
  })
})

describe('buildEntitySemanticJson', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    primeClient()
  })

  it('splits columns into roles', async () => {
    const doc = await buildEntitySemanticJson(makeAccessor(), 'public', 'orders', 'table')
    expect(doc.dimensions?.map((d) => d.name)).toEqual([
      'order_id',
      'customer_id',
      'status',
      'channel',
    ])
    expect(doc.time_dimensions?.map((d) => d.name)).toEqual(['placed_at'])
    expect(doc.facts?.map((d) => d.name)).toEqual(['total_amount'])
  })

  it('carries table and column comments', async () => {
    const doc = await buildEntitySemanticJson(makeAccessor(), 'public', 'orders', 'table')
    expect(doc.description).toBe('Customer orders.')
    const total = doc.facts?.find((f) => f.name === 'total_amount')
    expect(total?.description).toBe('Order total in USD.')
  })

  it('carries enum data type and sample values', async () => {
    const doc = await buildEntitySemanticJson(makeAccessor(), 'public', 'orders', 'table')
    const status = doc.dimensions?.find((d) => d.name === 'status')
    expect(status?.data_type).toBe('order_status')
    expect(status?.sample_values).toEqual(['pending', 'shipped', 'cancelled'])
    const channel = doc.dimensions?.find((d) => d.name === 'channel')
    expect(channel?.sample_values).toEqual(['web', 'retail', 'partner'])
  })

  it('sets the head fields', async () => {
    const doc = await buildEntitySemanticJson(makeAccessor(), 'public', 'orders', 'table')
    expect(doc.name).toBe('orders')
    expect(doc.schema).toBe('public')
    expect(doc.kind).toBe('table')
    expect(doc.primary_key).toEqual(['order_id'])
    expect(doc.relationships?.[0]?.right_table).toBe('public.customers')
  })

  it('omits empty sections', async () => {
    vi.mocked(_client.fetchColumns).mockResolvedValue([
      { name: 'note', type: 'text', nullable: true },
    ])
    vi.mocked(_client.fetchPrimaryKey).mockResolvedValue([])
    vi.mocked(_client.fetchForeignKeys).mockResolvedValue([])
    vi.mocked(_client.fetchTableComment).mockResolvedValue(null)
    const doc = await buildEntitySemanticJson(makeAccessor(), 'public', 'notes', 'table')
    expect(doc.facts).toBeUndefined()
    expect(doc.time_dimensions).toBeUndefined()
    expect(doc.relationships).toBeUndefined()
    expect(doc.primary_key).toBeUndefined()
    expect(doc.description).toBeUndefined()
  })

  it('survives missing pg_stats', async () => {
    vi.mocked(_client.fetchColumnStats).mockResolvedValue(new Map())
    const doc = await buildEntitySemanticJson(makeAccessor(), 'public', 'orders', 'table')
    const channel = doc.dimensions?.find((d) => d.name === 'channel')
    expect(channel?.sample_values).toBeUndefined()
  })
})
