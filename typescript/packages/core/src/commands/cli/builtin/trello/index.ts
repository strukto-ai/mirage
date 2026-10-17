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

import { TrelloConfigSchema } from '../../../../core/trello/config.ts'
import { Argument, CommandSpec } from '../../../spec/types.ts'
import { CLI, CLIHandler } from '../../types.ts'
import { assign } from './card/assign.ts'
import { comment } from './card/comment.ts'
import { commentUpdate } from './card/comment_update.ts'
import { create } from './card/create.ts'
import { label } from './card/label.ts'
import { move } from './card/move.ts'
import { unlabel } from './card/unlabel.ts'
import { update } from './card/update.ts'
import * as reads from './reads.ts'
import { trelloAccessor } from './util.ts'

const ARG = new Argument('texts', { metavar: '', nargs: '*' })

const CARD_ID = new Argument('--card_id', { help: 'Trello card ID' })

const LIST_ID = new Argument('--list_id', { help: 'Trello list ID' })

const LABEL_ID = new Argument('--label_id', { help: 'Trello label ID' })

const DESC = new Argument('--desc', { help: 'Inline description text' })

const DESC_FILE = new Argument('--desc_file', {
  type: 'path',
  help: 'Path to file containing description',
})

const TEXT = new Argument('--text', { help: 'Inline comment text' })

const TEXT_FILE = new Argument('--text_file', {
  type: 'path',
  help: 'Path to file containing text',
})

export const TRELLO = new CLI({
  spec: new CommandSpec({
    name: 'trello',
    description: 'Trello REST API client',
    subcommands: [
      new CommandSpec({
        name: 'board',
        description: 'Read boards',
        subcommands: [
          new CommandSpec({ name: 'list', description: 'List the boards in scope as JSON' }),
          new CommandSpec({ name: 'show', description: 'Get one board by ID', arguments: [ARG] }),
          new CommandSpec({
            name: 'members',
            description: "List a board's members",
            arguments: [ARG],
          }),
        ],
      }),
      new CommandSpec({
        name: 'list',
        description: 'Read lists',
        subcommands: [
          new CommandSpec({ name: 'list', description: "List a board's lists", arguments: [ARG] }),
        ],
      }),
      new CommandSpec({
        name: 'label',
        description: 'Read labels',
        subcommands: [
          new CommandSpec({ name: 'list', description: "List a board's labels", arguments: [ARG] }),
        ],
      }),
      new CommandSpec({
        name: 'card',
        description: 'Manage cards',
        subcommands: [
          new CommandSpec({
            name: 'list',
            description: 'List the cards in a list',
            arguments: [ARG],
          }),
          new CommandSpec({ name: 'show', description: 'Get one card by ID', arguments: [ARG] }),
          new CommandSpec({
            name: 'comments',
            description: "List a card's comments",
            arguments: [ARG],
          }),
          new CommandSpec({
            name: 'create',
            description: 'Create a new card',
            arguments: [LIST_ID, new Argument('--name', { help: 'Card name' }), DESC, DESC_FILE],
          }),
          new CommandSpec({
            name: 'update',
            description: 'Update an existing card',
            arguments: [
              CARD_ID,
              new Argument('--name', { help: 'New card name' }),
              DESC,
              DESC_FILE,
              new Argument('--due', { help: 'Due date' }),
              new Argument('--closed', { help: 'Archive card (true/false)' }),
            ],
          }),
          new CommandSpec({
            name: 'move',
            description: 'Move a card to a different list',
            arguments: [CARD_ID, LIST_ID],
          }),
          new CommandSpec({
            name: 'assign',
            description: 'Assign a member to a card',
            arguments: [CARD_ID, new Argument('--member_id', { help: 'Trello member ID' })],
          }),
          new CommandSpec({
            name: 'label',
            description: 'Add a label to a card',
            arguments: [CARD_ID, LABEL_ID],
          }),
          new CommandSpec({
            name: 'unlabel',
            description: 'Remove a label from a card',
            arguments: [CARD_ID, LABEL_ID],
          }),
          new CommandSpec({
            name: 'comment',
            description: 'Add a comment to a card',
            arguments: [CARD_ID, TEXT, TEXT_FILE],
          }),
          new CommandSpec({
            name: 'comment-update',
            description: 'Update an existing comment',
            arguments: [
              CARD_ID,
              new Argument('--comment_id', { help: 'Trello comment ID' }),
              TEXT,
              TEXT_FILE,
            ],
          }),
        ],
      }),
    ],
  }),
  handlers: {
    'board list': new CLIHandler({ fn: reads.boardList }),
    'board show': new CLIHandler({ fn: reads.boardShow }),
    'board members': new CLIHandler({ fn: reads.boardMembers }),
    'list list': new CLIHandler({ fn: reads.listList }),
    'label list': new CLIHandler({ fn: reads.labelList }),
    'card list': new CLIHandler({ fn: reads.cardList }),
    'card show': new CLIHandler({ fn: reads.cardShow }),
    'card comments': new CLIHandler({ fn: reads.cardComments }),
    'card create': new CLIHandler({ fn: create, write: true }),
    'card update': new CLIHandler({ fn: update, write: true }),
    'card move': new CLIHandler({ fn: move, write: true }),
    'card assign': new CLIHandler({ fn: assign, write: true }),
    'card label': new CLIHandler({ fn: label, write: true }),
    'card unlabel': new CLIHandler({ fn: unlabel, write: true }),
    'card comment': new CLIHandler({ fn: comment, write: true }),
    'card comment-update': new CLIHandler({ fn: commentUpdate, write: true }),
  },
  configModel: TrelloConfigSchema,
  accessor: trelloAccessor,
})
