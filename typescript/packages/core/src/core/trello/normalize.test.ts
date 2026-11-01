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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { JsonObject } from '../../types.ts'
import { jsonlBytesByCreatedAt } from '../render/json.ts'
import {
  normalizeBoard,
  normalizeCard,
  normalizeComment,
  normalizeLabel,
  normalizeList,
  normalizeMember,
  normalizeWorkspace,
} from './normalize.ts'

describe('normalize', () => {
  it('normalizes workspace with displayName', () => {
    expect(normalizeWorkspace({ id: 'w1', displayName: 'Team', name: 'team' })).toEqual({
      workspace_id: 'w1',
      workspace_name: 'Team',
    })
  })

  it('normalizes board', () => {
    expect(
      normalizeBoard({
        id: 'b1',
        name: 'Roadmap',
        idOrganization: 'w1',
        closed: false,
        url: 'https://trello.com/b/b1',
      }),
    ).toEqual({
      board_id: 'b1',
      board_name: 'Roadmap',
      workspace_id: 'w1',
      closed: false,
      url: 'https://trello.com/b/b1',
    })
  })

  it('normalizes list', () => {
    expect(
      normalizeList({ id: 'l1', name: 'Doing', idBoard: 'b1', closed: false, pos: 1024 }),
    ).toEqual({
      list_id: 'l1',
      list_name: 'Doing',
      board_id: 'b1',
      closed: false,
      pos: 1024,
    })
  })

  it('normalizes member', () => {
    expect(normalizeMember({ id: 'u1', username: 'alice', fullName: 'Alice C' })).toEqual({
      member_id: 'u1',
      username: 'alice',
      full_name: 'Alice C',
    })
  })

  it('normalizes label', () => {
    expect(normalizeLabel({ id: 'L1', name: 'urgent', color: 'red', idBoard: 'b1' })).toEqual({
      label_id: 'L1',
      label_name: 'urgent',
      color: 'red',
      board_id: 'b1',
    })
  })

  it('normalizes card with labels and members', () => {
    expect(
      normalizeCard({
        id: 'c1',
        name: 'fix bug',
        idBoard: 'b1',
        idList: 'l1',
        idMembers: ['u1', 'u2'],
        labels: [{ id: 'L1' }, { id: 'L2' }],
        due: '2025-01-01',
        dueComplete: false,
        closed: false,
        desc: 'desc',
        shortUrl: 'https://trello.com/c/c1',
      }),
    ).toEqual({
      card_id: 'c1',
      card_name: 'fix bug',
      board_id: 'b1',
      list_id: 'l1',
      member_ids: ['u1', 'u2'],
      label_ids: ['L1', 'L2'],
      due: '2025-01-01',
      due_complete: false,
      closed: false,
      desc: 'desc',
      url: 'https://trello.com/c/c1',
    })
  })

  it('normalizes card with empty arrays defaults', () => {
    const out = normalizeCard({ id: 'c1', name: 'x' })
    expect(out.member_ids).toEqual([])
    expect(out.label_ids).toEqual([])
    expect(out.desc).toBe('')
  })

  it('normalizes comment with member and data', () => {
    expect(
      normalizeComment(
        {
          id: 'a1',
          date: '2025-01-01T00:00:00Z',
          memberCreator: { id: 'u1', fullName: 'Alice', username: 'alice' },
          data: { text: 'hi' },
        },
        'c1',
      ),
    ).toEqual({
      comment_id: 'a1',
      card_id: 'c1',
      member_id: 'u1',
      member_name: 'Alice',
      text: 'hi',
      created_at: '2025-01-01T00:00:00Z',
    })
  })

  it('jsonlBytesByCreatedAt returns empty for empty input', () => {
    expect(jsonlBytesByCreatedAt([]).length).toBe(0)
  })

  it('jsonlBytesByCreatedAt sorts by created_at and ends with newline', () => {
    const rows: ReturnType<typeof normalizeComment>[] = [
      {
        comment_id: 'a',
        card_id: 'c',
        member_id: null,
        member_name: null,
        text: 'second',
        created_at: '2025-01-02',
      },
      {
        comment_id: 'b',
        card_id: 'c',
        member_id: null,
        member_name: null,
        text: 'first',
        created_at: '2025-01-01',
      },
    ]
    const bytes = jsonlBytesByCreatedAt(rows)
    const text = new TextDecoder().decode(bytes)
    const lines = text.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect((JSON.parse(lines[0] ?? '') as { text: string }).text).toBe('first')
    expect((JSON.parse(lines[1] ?? '') as { text: string }).text).toBe('second')
    expect(text.endsWith('\n')).toBe(true)
  })
})

const corpus = JSON.parse(
  readFileSync(
    new URL('../../../../../../integ/fixtures/normalized_records.json', import.meta.url),
    'utf8',
  ),
) as { cases: { id: string; backend: string; kind: string; value: JsonObject; expect: unknown }[] }

for (const entry of corpus.cases.filter((entry) => entry.backend === 'trello')) {
  it(entry.id, () => {
    const normalizers: Record<string, (record: JsonObject) => unknown> = {
      workspace: normalizeWorkspace,
      list: normalizeList,
      card: normalizeCard,
    }
    expect(normalizers[entry.kind]?.(entry.value)).toEqual(entry.expect)
  })
}
