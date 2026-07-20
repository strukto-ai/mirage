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
import {
  normalizeComment,
  normalizeCycle,
  normalizeDocument,
  normalizeIssue,
  normalizeLabel,
  normalizeProject,
  normalizeTeam,
  normalizeUser,
  toJsonBytes,
  toJsonlBytes,
} from './normalize.ts'

describe('normalize', () => {
  it('normalizes team with states', () => {
    const t = normalizeTeam({
      id: 't1',
      key: 'ENG',
      name: 'Engineering',
      timezone: 'UTC',
      updatedAt: '2026-01-01',
      states: { nodes: [{ id: 's1', name: 'Backlog', type: 'unstarted' }] },
    })
    expect(t.team_id).toBe('t1')
    expect(t.team_key).toBe('ENG')
    expect(t.states).toEqual([{ state_id: 's1', state_name: 'Backlog', type: 'unstarted' }])
  })

  it('normalizes user', () => {
    expect(
      normalizeUser({
        id: 'u1',
        name: 'Alice',
        displayName: 'alice',
        email: 'a@example.com',
        active: true,
        admin: false,
      }),
    ).toMatchObject({
      user_id: 'u1',
      display_name: 'alice',
      email: 'a@example.com',
      is_active: true,
      is_admin: false,
    })
  })

  it('normalizes issue with team/state/labels', () => {
    const i = normalizeIssue({
      id: 'i1',
      identifier: 'STR-1',
      title: 'fix bug',
      description: 'desc',
      priority: 2,
      team: { id: 't1', key: 'STR', name: 'Strukto' },
      state: { id: 's1', name: 'In Progress' },
      assignee: { id: 'u1', email: 'a@x', name: 'A' },
      labels: { nodes: [{ id: 'L1', name: 'bug' }] },
    })
    expect(i.issue_key).toBe('STR-1')
    expect(i.team_key).toBe('STR')
    expect(i.state_name).toBe('In Progress')
    expect(i.label_ids).toEqual(['L1'])
    expect(i.label_names).toEqual(['bug'])
  })

  it('normalizes comment', () => {
    expect(
      normalizeComment(
        {
          id: 'c1',
          body: 'hi',
          createdAt: '2026-01-01',
          user: { id: 'u1', displayName: 'alice', email: 'a@x' },
        },
        'i1',
        'STR-1',
      ),
    ).toMatchObject({
      comment_id: 'c1',
      issue_id: 'i1',
      issue_key: 'STR-1',
      body: 'hi',
      user_name: 'alice',
    })
  })

  it('normalizes project with issues', () => {
    expect(
      normalizeProject(
        { id: 'p1', name: 'Q1', state: 'started', lead: { id: 'u1' } },
        {
          teamId: 't1',
          teamKey: 'STR',
          teamName: 'Strukto',
          issues: [
            {
              issue_id: 'i1',
              issue_key: 'STR-1',
              title: 'a',
              state_id: 's1',
              state_name: 'Done',
              url: null,
            },
          ],
        },
      ),
    ).toMatchObject({
      project_id: 'p1',
      team_id: 't1',
      team_key: 'STR',
      lead_id: 'u1',
      issue_count: 1,
    })
  })

  it('normalizes cycle', () => {
    expect(
      normalizeCycle({ id: 'c1', name: 'Sprint 1', number: 1, startsAt: '2026-01-01' }, 't1'),
    ).toMatchObject({
      cycle_id: 'c1',
      team_id: 't1',
      number: 1,
    })
  })

  it('toJsonBytes pretty-prints', () => {
    const bytes = toJsonBytes({ a: 1 })
    expect(new TextDecoder().decode(bytes)).toBe('{\n  "a": 1\n}')
  })

  it('toJsonlBytes returns empty for empty', () => {
    expect(toJsonlBytes([]).length).toBe(0)
  })

  it('toJsonlBytes sorts by created_at', () => {
    const bytes = toJsonlBytes([
      {
        comment_id: 'a',
        issue_id: 'i',
        issue_key: null,
        user_id: null,
        user_email: null,
        user_name: null,
        body: 'second',
        created_at: '2026-01-02',
        updated_at: null,
        url: null,
      },
      {
        comment_id: 'b',
        issue_id: 'i',
        issue_key: null,
        user_id: null,
        user_email: null,
        user_name: null,
        body: 'first',
        created_at: '2026-01-01',
        updated_at: null,
        url: null,
      },
    ])
    const text = new TextDecoder().decode(bytes)
    const lines = text.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect((JSON.parse(lines[0] ?? '') as { body: string }).body).toBe('first')
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('normalizeLabel', () => {
  it('maps fields', () => {
    expect(normalizeLabel({ id: 'lbl_1', name: 'bug', color: '#ff0000' })).toEqual({
      label_id: 'lbl_1',
      name: 'bug',
      color: '#ff0000',
    })
  })

  it('tolerates missing fields', () => {
    expect(normalizeLabel({ id: 'lbl_2' })).toEqual({
      label_id: 'lbl_2',
      name: null,
      color: null,
    })
  })
})

describe('normalizeDocument', () => {
  it('resolves project and creator', () => {
    expect(
      normalizeDocument({
        id: 'doc_1',
        title: 'Runbook',
        content: 'restart the worker',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-02T00:00:00.000Z',
        url: 'https://linear.app/strukto/document/doc_1',
        project: { id: 'prj_1', name: 'Search' },
        creator: { id: 'usr_1', name: 'alex', email: 'alex@x.io' },
      }),
    ).toEqual({
      document_id: 'doc_1',
      title: 'Runbook',
      content: 'restart the worker',
      project_id: 'prj_1',
      project_name: 'Search',
      creator_id: 'usr_1',
      creator_name: 'alex',
      creator_email: 'alex@x.io',
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-05-02T00:00:00.000Z',
      url: 'https://linear.app/strukto/document/doc_1',
    })
  })

  it('defaults content and nulls', () => {
    expect(normalizeDocument({ id: 'doc_2', title: 'Empty' })).toEqual({
      document_id: 'doc_2',
      title: 'Empty',
      content: '',
      project_id: null,
      project_name: null,
      creator_id: null,
      creator_name: null,
      creator_email: null,
      created_at: null,
      updated_at: null,
      url: null,
    })
  })
})
