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
import { ResourceName } from '../../../types.ts'
import type { ProvisionFn, RegisteredCommand } from '../../config.ts'
import { fileReadProvision, metadataProvision } from './_provision.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { TRELLO_FIND } from './find.ts'
import { TRELLO_CMD_OPS } from './ops.ts'
import { TRELLO_CARD_ASSIGN } from './trello_card_assign.ts'
import { TRELLO_CARD_COMMENT_ADD } from './trello_card_comment_add.ts'
import { TRELLO_CARD_COMMENT_UPDATE } from './trello_card_comment_update.ts'
import { TRELLO_CARD_CREATE } from './trello_card_create.ts'
import { TRELLO_CARD_LABEL_ADD } from './trello_card_label_add.ts'
import { TRELLO_CARD_LABEL_REMOVE } from './trello_card_label_remove.ts'
import { TRELLO_CARD_MOVE } from './trello_card_move.ts'
import { TRELLO_CARD_UPDATE } from './trello_card_update.ts'

const TRELLO_OVERRIDES = new Set(['find', 'du'])

export const TRELLO_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<TrelloAccessor>(ResourceName.TRELLO, TRELLO_CMD_OPS, {
    overrides: TRELLO_OVERRIDES,
    provisionOverrides: {
      grep: fileReadProvision as ProvisionFn,
      rg: fileReadProvision as ProvisionFn,
      ls: metadataProvision as ProvisionFn,
    },
  }),
  ...TRELLO_FIND,
  ...TRELLO_CARD_ASSIGN,
  ...TRELLO_CARD_COMMENT_ADD,
  ...TRELLO_CARD_COMMENT_UPDATE,
  ...TRELLO_CARD_CREATE,
  ...TRELLO_CARD_LABEL_ADD,
  ...TRELLO_CARD_LABEL_REMOVE,
  ...TRELLO_CARD_MOVE,
  ...TRELLO_CARD_UPDATE,
]
