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

import type { SlackAccessor } from '../../../accessor/slack.ts'
import { ResourceName } from '../../../types.ts'
import type { ProvisionFn, RegisteredCommand } from '../../config.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { metadataProvision } from './_provision.ts'
import { SLACK_GREP } from './grep.ts'
import { SLACK_IO } from './io.ts'
import { SLACK_RG } from './rg.ts'
import { SLACK_ADD_REACTION } from './slack_add_reaction.ts'
import { SLACK_GET_USER_PROFILE } from './slack_get_user_profile.ts'
import { SLACK_GET_USERS } from './slack_get_users.ts'
import { SLACK_POST_MESSAGE } from './slack_post_message.ts'
import { SLACK_REPLY_TO_THREAD } from './slack_reply_to_thread.ts'
import { SLACK_SEARCH } from './slack_search.ts'

const SLACK_OVERRIDES = new Set(['grep', 'rg'])

export const SLACK_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<SlackAccessor>(ResourceName.SLACK, SLACK_IO, {
    overrides: SLACK_OVERRIDES,
    provisionOverrides: {
      ls: metadataProvision as ProvisionFn,
    },
  }),
  ...SLACK_GREP,
  ...SLACK_RG,
  ...SLACK_POST_MESSAGE,
  ...SLACK_REPLY_TO_THREAD,
  ...SLACK_ADD_REACTION,
  ...SLACK_GET_USERS,
  ...SLACK_GET_USER_PROFILE,
  ...SLACK_SEARCH,
]
