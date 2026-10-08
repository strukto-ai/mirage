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

import type { TrelloAccessor } from '../../../accessor/trello.ts'
import {
  getBoard,
  getCard,
  listBoardLabels,
  listBoardLists,
  listBoardMembers,
  listCardComments,
  listListCards,
} from '../../../core/trello/client.ts'
import { filteredBoards, filteredWorkspaces } from '../../../core/trello/readdir.ts'
import {
  normalizeBoard,
  normalizeCard,
  normalizeComment,
  normalizeLabel,
  normalizeList,
  normalizeMember,
  toJsonBytes,
} from '../../../core/trello/normalize.ts'
import { IOResult } from '../../../io/types.ts'
import { VFSName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts, type Command } from '../../config.ts'
import { CommandSpec, Operand } from '../../spec/types.ts'
import { requireBoard, requireCard, requireList } from './_scope.ts'

type Runner = (accessor: TrelloAccessor, texts: string[]) => Promise<Uint8Array>

interface TrelloRead {
  name: string
  runner: Runner
  spec: CommandSpec
}

const SPEC_NONE = new CommandSpec({})
const SPEC_ARG = new CommandSpec({ rest: new Operand({ type: 'str' }) })

function first(texts: string[], label: string): string {
  const value = texts[0]
  if (value === undefined || value === '') throw new Error(`${label} is required`)
  return value
}

async function runBoardList(accessor: TrelloAccessor): Promise<Uint8Array> {
  const boards: unknown[] = []
  for (const workspace of await filteredWorkspaces(accessor)) {
    const workspaceId = typeof workspace.id === 'string' ? workspace.id : ''
    for (const board of await filteredBoards(accessor, workspaceId)) {
      boards.push(normalizeBoard(board))
    }
  }
  return toJsonBytes(boards)
}

async function runBoardShow(accessor: TrelloAccessor, texts: string[]): Promise<Uint8Array> {
  const boardId = first(texts, 'board id')
  await requireBoard(accessor, boardId)
  const board = await getBoard(accessor.transport, boardId)
  return toJsonBytes(normalizeBoard(board))
}

async function runBoardMembers(accessor: TrelloAccessor, texts: string[]): Promise<Uint8Array> {
  const boardId = first(texts, 'board id')
  await requireBoard(accessor, boardId)
  const members = await listBoardMembers(accessor.transport, boardId)
  return toJsonBytes(members.map((member) => normalizeMember(member)))
}

async function runListList(accessor: TrelloAccessor, texts: string[]): Promise<Uint8Array> {
  const boardId = first(texts, 'board id')
  await requireBoard(accessor, boardId)
  const lists = await listBoardLists(accessor.transport, boardId)
  return toJsonBytes(lists.map((lst) => normalizeList(lst)))
}

async function runLabelList(accessor: TrelloAccessor, texts: string[]): Promise<Uint8Array> {
  const boardId = first(texts, 'board id')
  await requireBoard(accessor, boardId)
  const labels = await listBoardLabels(accessor.transport, boardId)
  return toJsonBytes(labels.map((label) => normalizeLabel(label)))
}

async function runCardList(accessor: TrelloAccessor, texts: string[]): Promise<Uint8Array> {
  const listId = first(texts, 'list id')
  await requireList(accessor, listId)
  const cards = await listListCards(accessor.transport, listId)
  return toJsonBytes(cards.map((card) => normalizeCard(card)))
}

async function runCardShow(accessor: TrelloAccessor, texts: string[]): Promise<Uint8Array> {
  const cardId = first(texts, 'card id')
  await requireCard(accessor, cardId)
  const card = await getCard(accessor.transport, cardId)
  return toJsonBytes(normalizeCard(card))
}

async function runCardComments(accessor: TrelloAccessor, texts: string[]): Promise<Uint8Array> {
  const cardId = first(texts, 'card id')
  await requireCard(accessor, cardId)
  const comments = await listCardComments(accessor.transport, cardId)
  return toJsonBytes(comments.map((comment) => normalizeComment(comment, cardId)))
}

const TRELLO_READS: readonly TrelloRead[] = [
  { name: 'trello board list', runner: (a) => runBoardList(a), spec: SPEC_NONE },
  { name: 'trello board show', runner: (a, t) => runBoardShow(a, t), spec: SPEC_ARG },
  { name: 'trello board members', runner: (a, t) => runBoardMembers(a, t), spec: SPEC_ARG },
  { name: 'trello list list', runner: (a, t) => runListList(a, t), spec: SPEC_ARG },
  { name: 'trello label list', runner: (a, t) => runLabelList(a, t), spec: SPEC_ARG },
  { name: 'trello card list', runner: (a, t) => runCardList(a, t), spec: SPEC_ARG },
  { name: 'trello card show', runner: (a, t) => runCardShow(a, t), spec: SPEC_ARG },
  { name: 'trello card comments', runner: (a, t) => runCardComments(a, t), spec: SPEC_ARG },
]

export function makeTrelloReadCommands(): Command[] {
  const commands: Command[] = []
  for (const entry of TRELLO_READS) {
    commands.push(
      ...command({
        name: entry.name,
        vfs: VFSName.TRELLO,
        spec: entry.spec,
        fn: async (
          accessor,
          _paths: PathSpec[],
          texts: string[],
          _opts: CommandOpts,
        ): Promise<CommandFnResult> => {
          const data = await entry.runner(accessor as TrelloAccessor, texts)
          return [data, new IOResult()]
        },
      }),
    )
  }
  return commands
}
