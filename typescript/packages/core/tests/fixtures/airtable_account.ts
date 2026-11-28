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

import { AirtableAccessor } from '../../src/accessor/airtable.ts'
import type { AirtableConfig } from '../../src/core/airtable/config.ts'
import { type JsonValue, KitRun } from './kit_fake.ts'

export const TOKEN = 'patTest0000000001.secret'
export const ROADMAP = 'appRoadmapBase001'
export const OPS = 'appOpsFinance0001'
export const FEATURES = 'tblFeatures000001'
export const BUDGET = 'tblBudget00000001'
export const GRID = 'viwGrid0000000001'
export const DONE = 'viwDone0000000001'
export const DONE_FORMULA = "{Status}='Done'"
export const RECORDS = '/v0/:base/:table'
export const RECORD = '/v0/:base/:table/:record'
export const COMMENTS = '/v0/:base/:table/:record/comments'
export const BASES = '/v0/meta/bases'
export const TABLES = '/v0/meta/bases/:base/tables'
// Airtable's answer for a base, table or record the token cannot reach.
export const MODEL_NOT_FOUND =
  'Invalid permissions, or the requested model was not found. Check that both your user ' +
  'and your token have the required permissions, and that the model names and/or ids ' +
  'are correct.'
// The world integ/fixtures/airtable/unit.json seeds: two bases, Features with
// seven records (the odd ones Done) and Q3 / Budget with one.
const FIXTURE = 'unit'
const WRITES: Record<string, string> = {
  [`POST ${RECORDS}`]: 'create',
  [`PATCH ${RECORDS}`]: 'update',
  [`DELETE ${RECORDS}`]: 'delete',
  [`POST ${COMMENTS}`]: 'comment',
}

type Row = Record<string, JsonValue>

/** A record as Airtable answers it. */
interface AirtableRecord {
  id: string
  createdTime: string
  fields: Row
}

interface Listed {
  requests: { method: string; route: string; path: string; query: string; body: JsonValue }[]
}

/**
 * One Airtable account on the integ Airtable fake, in the world the unit
 * fixture seeds, and the reads a test checks it by.
 */
export class AirtableAccount {
  readonly run: KitRun
  // What was recorded before the run was last reloaded.
  private earlier: Listed['requests'] = []

  constructor(origin: string) {
    this.run = new KitRun(origin, { Authorization: `Bearer ${TOKEN}` })
  }

  /**
   * Seed the run afresh with a fixture's world, the unit one unless named;
   * `pageCap` caps each page of records, comments or payloads.
   */
  async reset(pageCap?: number, fixture = FIXTURE): Promise<void> {
    await this.run.call('POST', '/reset', {
      json: pageCap === undefined ? { fixture } : { fixture, extras: { pageCap } },
    })
  }

  /** A config on the account, pacing off so a test runs at speed. */
  config(overrides: Partial<AirtableConfig> = {}): AirtableConfig {
    return {
      token: TOKEN,
      baseUrl: `${this.run.url}/v0`,
      requestsPerSecond: 10_000,
      ...overrides,
    } as AirtableConfig
  }

  /** A Mirage accessor on the account. */
  accessor(overrides: Partial<AirtableConfig> = {}): AirtableAccessor {
    return new AirtableAccessor(this.config(overrides))
  }

  /** Every record of a table, as Airtable answers them. */
  async records(base: string, table: string): Promise<AirtableRecord[]> {
    const found: AirtableRecord[] = []
    let offset: string | undefined
    for (;;) {
      const query = offset === undefined ? '' : `?offset=${encodeURIComponent(offset)}`
      const page = await this.run.call<{ records: AirtableRecord[]; offset?: string }>(
        'GET',
        `/v0/${base}/${encodeURIComponent(table)}${query}`,
      )
      found.push(...page.records)
      if (page.offset === undefined) return found
      offset = page.offset
    }
  }

  /** Create records as another client would, and their ids. */
  async create(base: string, table: string, ...cells: Row[]): Promise<string[]> {
    const made = await this.run.call<{ records: { id: string }[] }>(
      'POST',
      `/v0/${base}/${encodeURIComponent(table)}`,
      {
        json: { records: cells.map((fields) => ({ fields })) },
      },
    )
    return made.records.map((r) => r.id)
  }

  /** Start listing the account's requests afresh. */
  async recordRequests(): Promise<void> {
    this.earlier = []
    await this.run.recordRequests()
  }

  /**
   * Store a state no Airtable request makes, one SQL statement on the run.
   * That reloads the run, which stops a recording, so the requests listed so
   * far are kept and the recording starts again.
   */
  async store(sql: string, ...params: (string | number)[]): Promise<void> {
    this.earlier.push(...(await this.recorded()))
    await this.run.execute(sql, ...params)
    await this.run.recordRequests()
  }

  /** Make a webhook on a base, as its owner would, and its id. */
  async webhook(base: string): Promise<string> {
    const made = await this.run.call<{ id: string }>('POST', `/v0/bases/${base}/webhooks`, {
      json: { specification: { options: { filters: { dataTypes: ['tableData'] } } } },
    })
    return made.id
  }

  /** Delete a webhook, as its owner would. */
  async dropWebhook(base: string, hook: string): Promise<void> {
    await this.run.call('DELETE', `/v0/bases/${base}/webhooks/${hook}`)
  }

  /**
   * Add a payload to a webhook, numbered after its last. The fake writes
   * payloads only for record writes, so one about a schema or an error is
   * stored as Airtable would leave it.
   */
  async push(hook: string, payload: Row): Promise<void> {
    await this.store(
      'INSERT INTO AirtableWebhookPayload (tenant, webhookId, cursor, "transaction", body) ' +
        'SELECT tenant, id, lastCursor + 1, ' +
        '(SELECT COALESCE(MAX("transaction"), 0) + 1 FROM AirtableWebhookPayload ' +
        "WHERE tenant = 'default'), ? FROM AirtableWebhook WHERE tenant = 'default' AND id = ?",
      JSON.stringify(payload),
      hook,
    )
    await this.store(
      "UPDATE AirtableWebhook SET lastCursor = lastCursor + 1 WHERE tenant = 'default' AND id = ?",
      hook,
    )
  }

  /** Let a webhook's payloads before `oldest` expire, as Airtable lets them after seven days. */
  async expire(hook: string, oldest: number): Promise<void> {
    await this.store(
      "DELETE FROM AirtableWebhookPayload WHERE tenant = 'default' AND webhookId = ? AND cursor < ?",
      hook,
      oldest,
    )
  }

  private async recorded(): Promise<Listed['requests']> {
    return (await this.run.call<Listed>('GET', '/_kit/requests')).requests
  }

  /** Each request since recording started, the ones before a reload included. */
  async listed(): Promise<Listed['requests']> {
    return [...this.earlier, ...(await this.recorded())]
  }

  /** The query of each records listing since recording started, with the table it names. */
  async recordQueries(): Promise<Record<string, string>[]> {
    return (await this.listed())
      .filter((r) => r.method === 'GET' && r.route === RECORDS)
      .map((r) => ({
        ...Object.fromEntries(new URLSearchParams(r.query)),
        table: decodeURIComponent(r.path.split('/')[3] ?? ''),
      }))
  }

  /**
   * Each write since recording started, in order: `create`, `update` and
   * `comment` with the JSON they carried, `delete` with the record ids it named.
   */
  async writes(): Promise<{ kind: string; body: JsonValue }[]> {
    const out: { kind: string; body: JsonValue }[] = []
    for (const r of await this.listed()) {
      const kind = WRITES[`${r.method} ${r.route}`]
      if (kind === undefined) continue
      if (kind === 'delete') {
        const query = new URLSearchParams(r.query)
        out.push({ kind, body: [...query.getAll('records[]'), ...query.getAll('records')] })
      } else {
        out.push({ kind, body: r.body })
      }
    }
    return out
  }

  /** Each request since recording started, as `METHOD route`. */
  async asked(): Promise<string[]> {
    return (await this.listed()).map((r) => `${r.method} ${r.route}`)
  }
}
