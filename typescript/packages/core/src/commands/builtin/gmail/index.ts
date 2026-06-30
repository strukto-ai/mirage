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

import type { GmailAccessor } from '../../../accessor/gmail.ts'
import { ResourceName } from '../../../types.ts'
import type { ProvisionFn, RegisteredCommand } from '../../config.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { GMAIL_FIND } from './find.ts'
import { GMAIL_GREP } from './grep.ts'
import { GMAIL_GWS_DELETE } from './gws_gmail_delete.ts'
import { GMAIL_GWS_FORWARD } from './gws_gmail_forward.ts'
import { GMAIL_GWS_READ } from './gws_gmail_read.ts'
import { GMAIL_GWS_REPLY } from './gws_gmail_reply.ts'
import { GMAIL_GWS_REPLY_ALL } from './gws_gmail_reply_all.ts'
import { GMAIL_GWS_SEND } from './gws_gmail_send.ts'
import { GMAIL_GWS_TRIAGE } from './gws_gmail_triage.ts'
import { GMAIL_CMD_OPS } from './ops.ts'
import { metadataProvision } from './provision.ts'
import { GMAIL_RG } from './rg.ts'

const GMAIL_OVERRIDES = new Set(['grep', 'rg', 'find'])

export const GMAIL_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<GmailAccessor>(ResourceName.GMAIL, GMAIL_CMD_OPS, {
    overrides: GMAIL_OVERRIDES,
    provisionOverrides: {
      ls: metadataProvision as ProvisionFn,
    },
  }),
  ...GMAIL_FIND,
  ...GMAIL_GREP,
  ...GMAIL_RG,
  ...GMAIL_GWS_SEND,
  ...GMAIL_GWS_REPLY,
  ...GMAIL_GWS_REPLY_ALL,
  ...GMAIL_GWS_FORWARD,
  ...GMAIL_GWS_TRIAGE,
  ...GMAIL_GWS_READ,
  ...GMAIL_GWS_DELETE,
]
