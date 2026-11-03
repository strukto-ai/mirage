import { describe, expect, it, vi } from 'vitest'
import { LinearAccessor } from '../../../../../accessor/linear.ts'
import {
  LinearApiError,
  issueRelationCreate,
  issueRelationDelete,
  listIssueRelations,
  type LinearTransport,
} from '../../../../../core/linear/client.ts'
import { CommandTimeoutError } from '../../../../../errors/types.ts'
import { materialize } from '../../../../../io/types.ts'
import { context } from '../../../../../../tests/workspace/fixtures/context.ts'
import { CommandSpec } from '../../../../spec/types.ts'
import { LINEAR } from '../index.ts'
import { add, deleteRelation, listRelations, prepareReference } from './relation.ts'

const A = { id: 'iss_a', identifier: 'ENG-1', title: 'First' }
const B = { id: 'iss_b', identifier: 'ENG-2', title: 'Second' }
const ROW = { id: 'r1', type: 'blocks', issue: A, relatedIssue: B }

function page(
  nodes: unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
  incoming = false,
) {
  return {
    issue: {
      [incoming ? 'inverseRelations' : 'relations']: {
        nodes,
        pageInfo: { hasNextPage, endCursor },
      },
    },
  }
}

function recorder(responses: Record<string, unknown>[]) {
  const calls: { query: string; variables: Record<string, unknown> }[] = []
  const transport: LinearTransport = {
    graphql: (query, variables = {}) => {
      calls.push({ query, variables })
      const response = responses.shift()
      if (response === undefined) throw new Error('unexpected request')
      return Promise.resolve(response)
    },
  }
  return { accessor: new LinearAccessor(transport), transport, calls }
}

async function rendered(result: Awaited<ReturnType<typeof add>>) {
  if (result === null) throw new Error('missing result')
  const parsed: unknown = JSON.parse(new TextDecoder().decode(await materialize(result[0])))
  return parsed
}

describe('issue relations', () => {
  it('binds confirmation to the resolved command spec before deletion', async () => {
    const { accessor, calls } = recorder([
      { issue: A },
      { issue: B },
      page([ROW]),
      { issueRelationDelete: { success: true } },
    ])
    await expect(
      deleteRelation(
        accessor,
        [],
        ['ENG-1', 'blocks', 'ENG-2'],
        context({ flags: { yes: true }, spec: new CommandSpec({ name: 'delete' }) }),
      ),
    ).rejects.toThrow('not declared')
    expect(calls).toHaveLength(3)
  })

  it.each([
    ['BLOCKS', 'iss_a', 'iss_b', 'outgoing'],
    ['blocked-by', 'iss_b', 'iss_a', 'incoming'],
    ['related', 'iss_a', 'iss_b', 'outgoing'],
    ['duplicate', 'iss_a', 'iss_b', 'outgoing'],
  ])(
    'resolves operands and stores %s in the right direction',
    async (kind, source, target, direction) => {
      const type = kind === 'blocked-by' ? 'blocks' : kind.toLowerCase()
      const row = {
        id: 'r1',
        type,
        issue: source === A.id ? A : B,
        relatedIssue: target === B.id ? B : A,
      }
      const { accessor, calls } = recorder([
        { issue: A },
        { issue: B },
        { issueRelationCreate: { success: true, issueRelation: row } },
      ])
      const result = await rendered(
        await add(
          accessor,
          [],
          ['eng-1', kind, 'https://linear.app/acme/issue/ENG-2/title'],
          context(),
        ),
      )
      expect(result).toMatchObject({ issue_key: 'ENG-1', related_issue_key: 'ENG-2', direction })
      expect(calls.map((call) => call.variables)).toEqual([
        { issueId: 'ENG-1' },
        { issueId: 'ENG-2' },
        { input: { issueId: source, relatedIssueId: target, type } },
      ])
    },
  )

  it.each([
    'ENG-0',
    'https://linear.app../acme/issue/ENG-2',
    'https://linear.app/acme/issue/%FF',
    'https://evil.test/acme/issue/ENG-2',
    'https://linear.app:123/acme/issue/ENG-2',
    'https://linear.app/acme/issue/ENG-2#bad',
  ])('rejects invalid second operand %s before requests', async (bad) => {
    const { accessor, calls } = recorder([])
    await expect(add(accessor, [], ['ENG-1', 'blocks', bad], context())).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('rejects unknown kinds and extra operands before requests', async () => {
    const { accessor, calls } = recorder([])
    await expect(add(accessor, [], ['ENG-1', 'similar', 'ENG-2'], context())).rejects.toThrow(
      'invalid relation type',
    )
    await expect(
      add(accessor, [], ['ENG-1', 'blocks', 'ENG-2', 'extra'], context()),
    ).rejects.toThrow('expected ISSUE RELATION RELATED')
    expect(calls).toEqual([])
  })

  it.each([
    ['123A-42', '123A-42'],
    ['eng-1', 'ENG-1'],
    ['https://linear.app:443/acme/issue/ENG-1', 'ENG-1'],
    ['http://linear.app:80/acme/issue/ENG-1', 'ENG-1'],
    ['https://linear.app/acme/x/../issue/ENG-1', 'ENG-1'],
    ['https://linear.app/acme/x/%2e%2e/issue/ENG-1', 'ENG-1'],
    ['www.linear.app/acme/issue/eng-1/title#comment-deadbeef', 'ENG-1'],
    ['https://linear.app/acme/issue/ENG%2D1/title', 'ENG-1'],
    ['123e4567-e89b-12d3-a456-426614174000', '123e4567-e89b-12d3-a456-426614174000'],
    ['iss_plat1', 'iss_plat1'],
  ])('normalizes %s', (reference, expected) => {
    expect(prepareReference(reference)).toBe(expected)
  })

  it('exhausts both connections and distinguishes incoming duplicate orientation', async () => {
    const duplicate = { ...ROW, id: 'r2', type: 'duplicate', issue: B, relatedIssue: A }
    const { accessor, calls } = recorder([
      { issue: A },
      page([ROW], true, 'out'),
      page([]),
      page([duplicate], true, 'in', true),
      page([], false, null, true),
    ])
    const result = await rendered(await listRelations(accessor, [], ['ENG-1'], context()))
    expect(result).toMatchObject([
      { type: 'blocks', direction: 'outgoing', related_issue_key: 'ENG-2' },
      { type: 'duplicate', direction: 'incoming', related_issue_key: 'ENG-2' },
    ])
    expect(calls.slice(1).map((call) => call.variables.after)).toEqual([null, 'out', null, 'in'])
  })

  it('deletes the mapped exact direction found on a later page', async () => {
    const { accessor, calls } = recorder([
      { issue: B },
      { issue: A },
      page([], true, 'later'),
      page([ROW]),
      { issueRelationDelete: { success: true } },
    ])
    const result = await rendered(
      await deleteRelation(
        accessor,
        [],
        ['ENG-2', 'blocked-by', 'ENG-1'],
        context({ flags: { yes: true } }),
      ),
    )
    expect(result).toMatchObject({ type: 'blocked-by', direction: 'incoming' })
    expect(calls[2]?.variables.issueId).toBe('iss_a')
    expect(calls.at(-1)?.variables).toEqual({ id: 'r1' })
  })

  it.each([true, false])(
    'checks relation existence before confirmation, exists=%s',
    async (exists) => {
      const { accessor, calls } = recorder([{ issue: A }, { issue: B }, page(exists ? [ROW] : [])])
      await expect(
        deleteRelation(accessor, [], ['ENG-1', 'blocks', 'ENG-2'], context()),
      ).rejects.toThrow(exists ? '--yes' : 'relation')
      expect(calls).toHaveLength(3)
    },
  )

  it.each([null, '', 'same'])('refuses nonadvancing pagination cursor %s', async (cursor) => {
    const { transport, calls } = recorder([page([], true, cursor), page([], true, cursor)])
    await expect(listIssueRelations(transport, 'iss_a')).rejects.toThrow('pagination')
    expect(calls).toHaveLength(cursor === 'same' ? 2 : 1)
  })

  it.each([{ success: false }, {}, { success: 'yes' }])(
    'does not retry failed create or delete outcomes %j',
    async (payload) => {
      const create = recorder([{ issueRelationCreate: payload }])
      await expect(issueRelationCreate(create.transport, {})).rejects.toThrow()
      expect(create.calls).toHaveLength(1)
      const deletion = recorder([{ issueRelationDelete: payload }])
      await expect(issueRelationDelete(deletion.transport, 'r1')).rejects.toThrow()
      expect(deletion.calls).toHaveLength(1)
    },
  )

  it.each([null, { id: '' }, { id: 'x' }])(
    'does not mutate after bad resolution %j',
    async (issue) => {
      const { accessor, calls } = recorder([{ issue }])
      await expect(add(accessor, [], ['ENG-1', 'blocks', 'ENG-2'], context())).rejects.toThrow()
      expect(calls).toHaveLength(1)
    },
  )

  it.each([null, { ...ROW, type: 'related' }, { ...ROW, issue: B }])(
    'reports unknown creation outcome once for an unconfirmed relation %j',
    async (created) => {
      const { transport, calls } = recorder([
        { issueRelationCreate: { success: true, issueRelation: created } },
      ])
      await expect(
        issueRelationCreate(transport, { issueId: A.id, relatedIssueId: B.id, type: 'blocks' }),
      ).rejects.toThrow('outcome is unknown')
      expect(calls).toHaveLength(1)
    },
  )

  it('preserves policy write classification', () => {
    expect(LINEAR.handlers['issue relation add']?.write).toBe(true)
    expect(LINEAR.handlers['issue relation delete']?.write).toBe(true)
    expect(LINEAR.handlers['issue relation list']?.write).toBe(false)
  })
})

describe.each(['create', 'delete'])('relation %s request failures', (operation) => {
  it.each([
    new DOMException('caller canceled', 'AbortError'),
    new CommandTimeoutError('linear', 1),
  ])('preserves caller cancellation or budget timeout %s', async (failure) => {
    const request = vi.fn().mockRejectedValue(failure)
    const transport: LinearTransport = { graphql: request }
    const pending =
      operation === 'create'
        ? issueRelationCreate(transport, {})
        : issueRelationDelete(transport, 'r1')
    await expect(pending).rejects.toBe(failure)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    new TypeError('fetch failed'),
    new DOMException('reply timed out', 'TimeoutError'),
    new SyntaxError('truncated reply'),
    new LinearApiError('upstream unavailable', [], 503),
  ])('reports an uncertain outcome and preserves %s without retry', async (failure) => {
    const request = vi.fn().mockRejectedValue(failure)
    const transport: LinearTransport = { graphql: request }
    const pending =
      operation === 'create'
        ? issueRelationCreate(transport, {})
        : issueRelationDelete(transport, 'r1')
    await expect(pending).rejects.toThrow('outcome is unknown')
    await expect(pending).rejects.toHaveProperty('cause', failure)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    new LinearApiError('access denied', [], 403),
    new LinearApiError('invalid relation', [{ message: 'invalid relation' }]),
  ])('preserves a confirmed refusal %s', async (failure) => {
    const request = vi.fn().mockRejectedValue(failure)
    const transport: LinearTransport = { graphql: request }
    const pending =
      operation === 'create'
        ? issueRelationCreate(transport, {})
        : issueRelationDelete(transport, 'r1')
    await expect(pending).rejects.toBe(failure)
    expect(request).toHaveBeenCalledTimes(1)
  })
})
