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

import type { TrelloAccessor } from '../../accessor/trello.ts'
import { FileChangeKind, type FileEvent, type JsonValue, type PathSpec } from '../../types.ts'
import { eventAt, field, textField } from '../../watch/events.ts'
import { TrelloApiError, getBoard, getCard, getList, listWorkspaces } from './client.ts'
import { boardDirname, cardDirname, listDirname, workspaceDirname } from './pathing.ts'

const CARD_FILES = ['card.json', 'comments.jsonl'] as const

const CARD_MADE: ReadonlySet<string> = new Set([
  'createCard',
  'copyCard',
  'convertToCardFromCheckItem',
  'moveCardToBoard',
])
const CARD_GONE: ReadonlySet<string> = new Set(['deleteCard', 'moveCardFromBoard'])
const CARD_EDITS: ReadonlySet<string> = new Set([
  'addLabelToCard',
  'removeLabelFromCard',
  'addMemberToCard',
  'removeMemberFromCard',
])
const COMMENT_EDITS: ReadonlySet<string> = new Set([
  'commentCard',
  'updateComment',
  'deleteComment',
])
const LABEL_EDITS: ReadonlySet<string> = new Set(['createLabel', 'updateLabel', 'deleteLabel'])
const MEMBER_EDITS: ReadonlySet<string> = new Set(['addMemberToBoard', 'removeMemberFromBoard'])

/**
 * An entity's id and name as the dirname helpers read them.
 *
 * Mirrors Python `_named` (`core/trello/watch.py`).
 */
function named(entity: JsonValue, name?: string): Record<string, string> {
  return {
    id: textField(entity, 'id') ?? '',
    name: (name ?? '') || (textField(entity, 'name') ?? ''),
  }
}

/**
 * Map one Trello webhook delivery onto mount paths.
 *
 * The consumer owns the callback URL and passes the action's `type` with the
 * whole delivery body (`action` and `model`). Nothing here runs a loop.
 *
 * Every directory is `<name>__<id>`, and an action names the board, list and
 * card it touched with both, so a path is built from the action alone; only
 * the workspace a board sits in is read, once per board, from the delivery's
 * board `model` or `/boards/<id>`. A board outside the mount's `workspaceId`
 * or `boardIds` maps to nothing.
 *
 * A card is the directory `.../lists/<list>/cards/<card>` with `card.json` and
 * `comments.jsonl`. A card made or moved in creates both, and one deleted,
 * archived or moved to another board deletes its directory; a deleted card
 * names no name, so where the hook saw it last is used, and a card it never
 * saw makes its list's `cards` UNKNOWN. An action on a card that does not name
 * its list (a label or a member added) reads the card and its list once, and
 * one Trello no longer has makes the board UNKNOWN. A card renamed or moved
 * to another list moves both files. A comment updates `comments.jsonl`, and a
 * change to what `card.json` renders (its fields, labels or members) updates
 * that.
 *
 * A list or a board renamed moves everything below it, which no action lists,
 * so the old and new directory are UNKNOWN, and the cards the hook remembers
 * below it move with it; one archived is deleted, and one restored is UNKNOWN.
 * A board moved out of the mount's workspace is deleted where it was. Any
 * other change to a list or a board updates its `list.json` or `board.json`. A
 * label or a board member added, changed or removed is UNKNOWN on `labels` or
 * `members`, since the file names come from what changed.
 *
 * Mirrors Python `TrelloEventHook` (`core/trello/watch.py`).
 */
export class TrelloEventHook {
  private readonly accessor: TrelloAccessor
  private readonly workspaces = new Map<string, string>()
  private readonly orgs = new Map<string, string | undefined>()
  private readonly cards = new Map<string, string>()

  constructor(accessor: TrelloAccessor) {
    this.accessor = accessor
  }

  private async workspaceDir(workspaceId: string): Promise<string | undefined> {
    if (!this.workspaces.has(workspaceId)) {
      for (const listed of await listWorkspaces(this.accessor.transport)) {
        this.workspaces.set(String(listed.id), workspaceDirname(listed))
      }
    }
    return this.workspaces.get(workspaceId)
  }

  private async org(boardId: string, model: JsonValue): Promise<string | undefined> {
    if (textField(model, 'id') === boardId) {
      this.orgs.set(boardId, textField(model, 'idOrganization'))
    }
    if (!this.orgs.has(boardId)) {
      const board = await getBoard(this.accessor.transport, boardId)
      this.orgs.set(boardId, textField(board as JsonValue, 'idOrganization'))
    }
    return this.orgs.get(boardId)
  }

  private async boardDir(
    board: JsonValue,
    model: JsonValue,
    name?: string,
    org?: string,
  ): Promise<string | null> {
    const boardId = textField(board, 'id')
    if (boardId === undefined) return null
    const { boardIds, workspaceId: only } = this.accessor
    if (boardIds !== null && boardIds.length > 0 && !boardIds.includes(boardId)) return null
    const workspaceId = org ?? (await this.org(boardId, model))
    if (workspaceId === undefined || (only !== null && only !== '' && workspaceId !== only)) {
      return null
    }
    const workspace = await this.workspaceDir(workspaceId)
    if (workspace === undefined) return null
    return `workspaces/${workspace}/boards/${boardDirname(named(board, name))}`
  }

  private cardDir(boardDir: string, card: JsonValue, lst: JsonValue, name?: string): string | null {
    const cardId = textField(card, 'id')
    if (cardId === undefined) return null
    if (textField(lst, 'id') === undefined || !((name ?? '') || textField(card, 'name'))) {
      return this.cards.get(cardId) ?? null
    }
    const place =
      `${boardDir}/lists/${listDirname(named(lst))}/cards/` + cardDirname(named(card, name))
    this.cards.set(cardId, place)
    return place
  }

  // Where a card an action names without its list is, read from the card and
  // its list, or null when Trello no longer has either, as for a delivery
  // that arrives after the card was deleted.
  private async located(boardDir: string, cardId: string): Promise<string | null> {
    try {
      const found = (await getCard(this.accessor.transport, cardId)) as JsonValue
      const listId = textField(found, 'idList')
      if (listId === undefined) return null
      const lst = (await getList(this.accessor.transport, listId)) as JsonValue
      return this.cardDir(boardDir, found, lst)
    } catch (err) {
      if (!(err instanceof TrelloApiError) || err.status !== 404) throw err
      console.debug(`trello watch: card ${cardId} is gone: ${err.message}`)
      return null
    }
  }

  // Carry each remembered card below a list or board that moved to its new
  // place, or forget it when the place left the mount.
  private rebase(old: string, now: string | null): void {
    for (const [cardId, place] of [...this.cards]) {
      if (!place.startsWith(`${old}/`)) continue
      if (now === null) this.cards.delete(cardId)
      else this.cards.set(cardId, now + place.slice(old.length))
    }
  }

  private files(root: PathSpec, place: string, kind: FileChangeKind): FileEvent[] {
    return CARD_FILES.map((name) => eventAt(root, `${place}/${name}`, kind))
  }

  private async updateCard(
    root: PathSpec,
    boardDir: string,
    data: JsonValue,
  ): Promise<readonly FileEvent[]> {
    const card = field(data, 'card') ?? null
    const old = field(data, 'old') ?? null
    const lst = field(data, 'list') ?? null
    const was = this.cardDir(
      boardDir,
      card,
      field(data, 'listBefore') ?? lst,
      textField(old, 'name'),
    )
    let now = this.cardDir(boardDir, card, field(data, 'listAfter') ?? lst)
    const cardId = textField(card, 'id')
    if (now === null && cardId !== undefined) {
      now = await this.located(boardDir, cardId)
      if (now === null) return [eventAt(root, boardDir, FileChangeKind.UNKNOWN)]
    }
    if (now === null) return []
    if (field(old, 'closed') !== undefined && field(old, 'closed') !== null) {
      if (field(card, 'closed') === true) {
        this.cards.delete(textField(card, 'id') ?? '')
        return [eventAt(root, now, FileChangeKind.DELETE)]
      }
      return this.files(root, now, FileChangeKind.CREATE)
    }
    if (was !== null && was !== now) {
      return CARD_FILES.map((name) =>
        eventAt(root, `${now}/${name}`, FileChangeKind.MOVE, `${was}/${name}`),
      )
    }
    return [eventAt(root, `${now}/card.json`, FileChangeKind.UPDATE)]
  }

  private async card(
    root: PathSpec,
    kind: string,
    boardDir: string,
    data: JsonValue,
  ): Promise<readonly FileEvent[]> {
    if (kind === 'updateCard') return this.updateCard(root, boardDir, data)
    const card = field(data, 'card') ?? null
    const lst = field(data, 'list') ?? null
    let place = this.cardDir(boardDir, card, lst)
    if (CARD_GONE.has(kind)) {
      this.cards.delete(textField(card, 'id') ?? '')
      if (place !== null) return [eventAt(root, place, FileChangeKind.DELETE)]
      if (textField(lst, 'id') === undefined) return []
      const cards = `${boardDir}/lists/${listDirname(named(lst))}/cards`
      return [eventAt(root, cards, FileChangeKind.UNKNOWN)]
    }
    const cardId = textField(card, 'id')
    if (place === null && cardId !== undefined) {
      place = await this.located(boardDir, cardId)
      if (place === null) return [eventAt(root, boardDir, FileChangeKind.UNKNOWN)]
    }
    if (place === null) return []
    if (CARD_MADE.has(kind)) return this.files(root, place, FileChangeKind.CREATE)
    const name = COMMENT_EDITS.has(kind) ? 'comments.jsonl' : 'card.json'
    return [eventAt(root, `${place}/${name}`, FileChangeKind.UPDATE)]
  }

  private list(
    root: PathSpec,
    kind: string,
    boardDir: string,
    data: JsonValue,
  ): readonly FileEvent[] {
    const lst = field(data, 'list') ?? null
    if (textField(lst, 'id') === undefined) return []
    const lists = `${boardDir}/lists`
    const now = `${lists}/${listDirname(named(lst))}`
    const old = field(data, 'old') ?? null
    const closedChanged = field(old, 'closed') !== undefined && field(old, 'closed') !== null
    if (kind === 'createList') return [eventAt(root, `${now}/list.json`, FileChangeKind.CREATE)]
    if (kind === 'moveListFromBoard' || (closedChanged && field(lst, 'closed') === true)) {
      this.rebase(now, null)
      return [eventAt(root, now, FileChangeKind.DELETE)]
    }
    const oldName = textField(old, 'name')
    if (oldName !== undefined) {
      const was = `${lists}/${listDirname(named(lst, oldName))}`
      this.rebase(was, now)
      return [
        eventAt(root, was, FileChangeKind.UNKNOWN),
        eventAt(root, now, FileChangeKind.UNKNOWN),
      ]
    }
    if (kind === 'moveListToBoard' || closedChanged) {
      return [eventAt(root, now, FileChangeKind.UNKNOWN)]
    }
    return [eventAt(root, `${now}/list.json`, FileChangeKind.UPDATE)]
  }

  private async board(
    root: PathSpec,
    boardDir: string,
    data: JsonValue,
    model: JsonValue,
  ): Promise<readonly FileEvent[]> {
    const board = field(data, 'board') ?? null
    const old = field(data, 'old') ?? null
    if (field(old, 'closed') !== undefined && field(old, 'closed') !== null) {
      if (field(board, 'closed') !== true) return [eventAt(root, boardDir, FileChangeKind.UNKNOWN)]
      this.rebase(boardDir, null)
      return [eventAt(root, boardDir, FileChangeKind.DELETE)]
    }
    const oldName = textField(old, 'name')
    const oldOrg = textField(old, 'idOrganization')
    if (oldName === undefined && oldOrg === undefined) {
      return [eventAt(root, `${boardDir}/board.json`, FileChangeKind.UPDATE)]
    }
    const events = [eventAt(root, boardDir, FileChangeKind.UNKNOWN)]
    const was = await this.boardDir(board, model, oldName, oldOrg)
    if (was !== null && was !== boardDir) {
      this.rebase(was, boardDir)
      events.unshift(eventAt(root, was, FileChangeKind.UNKNOWN))
    }
    return events
  }

  // Map an `updateBoard` that moved a board out of the workspace the mount
  // shows: it is deleted where it was.
  private async left(
    root: PathSpec,
    data: JsonValue,
    model: JsonValue,
  ): Promise<readonly FileEvent[]> {
    const old = field(data, 'old') ?? null
    const oldOrg = textField(old, 'idOrganization')
    if (oldOrg === undefined) return []
    const was = await this.boardDir(
      field(data, 'board') ?? null,
      model,
      textField(old, 'name'),
      oldOrg,
    )
    if (was === null) return []
    this.rebase(was, null)
    return [eventAt(root, was, FileChangeKind.DELETE)]
  }

  async toEvents(
    root: PathSpec,
    eventType: string,
    payload: JsonValue,
  ): Promise<readonly FileEvent[]> {
    const data = field(field(payload, 'action') ?? null, 'data') ?? null
    const model = field(payload, 'model') ?? null
    const boardDir = await this.boardDir(field(data, 'board') ?? null, model)
    if (boardDir === null) {
      return eventType === 'updateBoard' ? this.left(root, data, model) : []
    }
    if (
      CARD_MADE.has(eventType) ||
      CARD_GONE.has(eventType) ||
      CARD_EDITS.has(eventType) ||
      COMMENT_EDITS.has(eventType) ||
      eventType === 'updateCard'
    ) {
      return this.card(root, eventType, boardDir, data)
    }
    if (['createList', 'updateList', 'moveListFromBoard', 'moveListToBoard'].includes(eventType)) {
      return this.list(root, eventType, boardDir, data)
    }
    if (eventType === 'updateBoard') return this.board(root, boardDir, data, model)
    if (LABEL_EDITS.has(eventType)) {
      return [eventAt(root, `${boardDir}/labels`, FileChangeKind.UNKNOWN)]
    }
    if (MEMBER_EDITS.has(eventType)) {
      return [eventAt(root, `${boardDir}/members`, FileChangeKind.UNKNOWN)]
    }
    return []
  }
}
