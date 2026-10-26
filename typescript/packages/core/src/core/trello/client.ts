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

import { apiRequest } from '../api/client.ts'
import { rstripSlash } from '../../utils/slash.ts'

export class TrelloApiError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly status: number,
    message: string,
  ) {
    super(`Trello API error (${endpoint}): HTTP ${String(status)}: ${message}`)
    this.name = 'TrelloApiError'
  }
}

export interface TrelloTransport {
  call(
    method: string,
    path: string,
    params?: Record<string, string>,
    body?: unknown,
  ): Promise<unknown>
}

export interface HttpTrelloTransportOptions {
  apiKey: string
  apiToken: string
  baseUrl?: string
  timeout?: number
}

export class HttpTrelloTransport implements TrelloTransport {
  protected readonly fetch: typeof fetch = globalThis.fetch.bind(globalThis)
  private readonly apiKey: string
  private readonly apiToken: string
  private readonly baseUrl: string
  private readonly timeout: number | undefined

  constructor(opts: HttpTrelloTransportOptions) {
    this.apiKey = opts.apiKey
    this.apiToken = opts.apiToken
    this.baseUrl = rstripSlash(opts.baseUrl ?? 'https://api.trello.com/1')
    this.timeout = opts.timeout
  }

  async call(
    method: string,
    path: string,
    params?: Record<string, string>,
    body?: unknown,
  ): Promise<unknown> {
    // auth first, so a caller's params can overwrite key/token
    return apiRequest(method, `${this.baseUrl}${path}`, {
      fetchFn: this.fetch,
      timeout: this.timeout,
      params: { key: this.apiKey, token: this.apiToken, ...params },
      ...(body !== undefined
        ? { json: body, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        : {}),
      errorOf: (response, text) => new TrelloApiError(path, response.status, text),
    })
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asObject(value: unknown, endpoint: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TrelloApiError(endpoint, 0, 'unexpected response shape')
  }
  return value as Record<string, unknown>
}

export async function listWorkspaces(
  transport: TrelloTransport,
): Promise<Record<string, unknown>[]> {
  const result = await transport.call('GET', '/members/me/organizations')
  return asArray(result) as Record<string, unknown>[]
}

export async function listWorkspaceBoards(
  transport: TrelloTransport,
  workspaceId: string,
): Promise<Record<string, unknown>[]> {
  const result = await transport.call('GET', `/organizations/${workspaceId}/boards`, {
    filter: 'open',
  })
  return asArray(result) as Record<string, unknown>[]
}

export async function getBoard(
  transport: TrelloTransport,
  boardId: string,
): Promise<Record<string, unknown>> {
  const result = await transport.call('GET', `/boards/${boardId}`)
  return asObject(result, `/boards/${boardId}`)
}

export async function listBoardLists(
  transport: TrelloTransport,
  boardId: string,
): Promise<Record<string, unknown>[]> {
  const result = await transport.call('GET', `/boards/${boardId}/lists`, { filter: 'open' })
  return asArray(result) as Record<string, unknown>[]
}

export async function getList(
  transport: TrelloTransport,
  listId: string,
): Promise<Record<string, unknown>> {
  const result = await transport.call('GET', `/lists/${listId}`)
  return asObject(result, `/lists/${listId}`)
}

export async function listBoardMembers(
  transport: TrelloTransport,
  boardId: string,
): Promise<Record<string, unknown>[]> {
  const result = await transport.call('GET', `/boards/${boardId}/members`)
  return asArray(result) as Record<string, unknown>[]
}

export async function listBoardLabels(
  transport: TrelloTransport,
  boardId: string,
): Promise<Record<string, unknown>[]> {
  const result = await transport.call('GET', `/boards/${boardId}/labels`)
  return asArray(result) as Record<string, unknown>[]
}

export async function listListCards(
  transport: TrelloTransport,
  listId: string,
): Promise<Record<string, unknown>[]> {
  const result = await transport.call('GET', `/lists/${listId}/cards`, {
    members: 'true',
    member_fields: 'id,username,fullName',
  })
  return asArray(result) as Record<string, unknown>[]
}

/** The cards Trello's search names for `query`, ids only. */
export async function searchCards(
  transport: TrelloTransport,
  query: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const result = await transport.call('GET', '/search', {
    query,
    modelTypes: 'cards',
    card_fields: 'id',
    cards_limit: String(limit),
    partial: 'false',
  })
  const cards = asObject(result, '/search').cards
  const valid =
    Array.isArray(cards) &&
    cards.every(
      (card: unknown) =>
        card !== null &&
        typeof card === 'object' &&
        typeof (card as Record<string, unknown>).id === 'string',
    )
  if (!valid) throw new TrelloApiError('/search', 0, 'unexpected response shape')
  return cards as Record<string, unknown>[]
}

export async function getCard(
  transport: TrelloTransport,
  cardId: string,
): Promise<Record<string, unknown>> {
  const result = await transport.call('GET', `/cards/${cardId}`, {
    members: 'true',
    member_fields: 'id,username,fullName',
  })
  return asObject(result, `/cards/${cardId}`)
}

export async function listCardComments(
  transport: TrelloTransport,
  cardId: string,
): Promise<Record<string, unknown>[]> {
  const result = await transport.call('GET', `/cards/${cardId}/actions`, {
    filter: 'commentCard',
  })
  return asArray(result) as Record<string, unknown>[]
}

export interface CardCreateInput {
  listId: string
  name: string
  desc?: string | null
}

export async function cardCreate(
  transport: TrelloTransport,
  input: CardCreateInput,
): Promise<Record<string, unknown>> {
  const params: Record<string, string> = { idList: input.listId, name: input.name }
  if (input.desc !== undefined && input.desc !== null && input.desc !== '') {
    params.desc = input.desc
  }
  const result = await transport.call('POST', '/cards', params)
  const created = asObject(result, '/cards')
  const id = created.id
  if (typeof id !== 'string') throw new TrelloApiError('/cards', 0, 'card create returned no id')
  return getCard(transport, id)
}

export interface CardUpdateInput {
  cardId: string
  name?: string | null
  desc?: string | null
  closed?: boolean | null
  due?: string | null
  dueComplete?: boolean | null
}

export async function cardUpdate(
  transport: TrelloTransport,
  input: CardUpdateInput,
): Promise<Record<string, unknown>> {
  const params: Record<string, string> = {}
  if (input.name !== undefined && input.name !== null) params.name = input.name
  if (input.desc !== undefined && input.desc !== null) params.desc = input.desc
  if (input.closed !== undefined && input.closed !== null) {
    params.closed = input.closed ? 'true' : 'false'
  }
  if (input.due !== undefined && input.due !== null) params.due = input.due
  if (input.dueComplete !== undefined && input.dueComplete !== null) {
    params.dueComplete = input.dueComplete ? 'true' : 'false'
  }
  if (Object.keys(params).length === 0) {
    throw new Error('no updates provided')
  }
  await transport.call('PUT', `/cards/${input.cardId}`, params)
  return getCard(transport, input.cardId)
}

export async function cardMove(
  transport: TrelloTransport,
  cardId: string,
  listId: string,
): Promise<Record<string, unknown>> {
  await transport.call('PUT', `/cards/${cardId}`, { idList: listId })
  return getCard(transport, cardId)
}

export async function cardAssign(
  transport: TrelloTransport,
  cardId: string,
  memberId: string,
): Promise<Record<string, unknown>> {
  await transport.call('POST', `/cards/${cardId}/idMembers`, { value: memberId })
  return getCard(transport, cardId)
}

export async function cardAddLabel(
  transport: TrelloTransport,
  cardId: string,
  labelId: string,
): Promise<Record<string, unknown>> {
  await transport.call('POST', `/cards/${cardId}/idLabels`, { value: labelId })
  return getCard(transport, cardId)
}

export async function cardRemoveLabel(
  transport: TrelloTransport,
  cardId: string,
  labelId: string,
): Promise<Record<string, unknown>> {
  await transport.call('DELETE', `/cards/${cardId}/idLabels/${labelId}`)
  return getCard(transport, cardId)
}

export async function commentCreate(
  transport: TrelloTransport,
  cardId: string,
  text: string,
): Promise<Record<string, unknown>> {
  const result = await transport.call('POST', `/cards/${cardId}/actions/comments`, { text })
  return asObject(result, `/cards/${cardId}/actions/comments`)
}

export async function commentUpdate(
  transport: TrelloTransport,
  cardId: string,
  commentId: string,
  text: string,
): Promise<Record<string, unknown>> {
  const result = await transport.call('PUT', `/cards/${cardId}/actions/${commentId}/comments`, {
    text,
  })
  return asObject(result, `/cards/${cardId}/actions/${commentId}/comments`)
}
