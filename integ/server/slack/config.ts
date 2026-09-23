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

import { parseConfig, schemaFor } from '../kit/typescript/index.ts'
import type { PrismaClient } from '../../generated/slack/index.js'

export type C = PrismaClient

export const config = parseConfig({
  service: 'slack',
  schema: schemaFor('slack'),
  defaultPort: 5097,
  tenantKind: 'pk-column',
  tenantFromBearer: true,
  // One workspace is reached with two tokens: `xoxb-<id>` for most methods and
  // `xoxp-<id>` for search.*, because real Slack requires a user token to
  // search. Taking the bearer verbatim would make those two different tenants
  // and every search would read an empty workspace, so the actor type is
  // stripped and both spellings land on the same one.
  tenantTokenPattern: '^xox[a-z]-(.+)$',
  // Per-kind, NOT the kit's global default: chat.postMessage's ts counter was
  // its own `postSeq` in the fake this replaces, so sharing one counter with
  // the pin ids made the first posted message land on .000002 whenever a pin
  // was created first. The ts is printed verbatim in goldens.
  mintSharing: 'per-kind',
})

// chat.postMessage assigns synthetic, deterministic ts values so the write
// commands produce byte-identical output on both hosts. The counter is the
// run's minter, so it resets with /reset exactly as the old module-level
// postSeq did.
export const POST_TS_BASE = 1775000000
export const BOT_USER_ID = 'UBOT'
// Who auth.test says holds the token. The fake does not model token holders
// (xoxb and xoxp reach one workspace, and every write is made as BOT_USER_ID),
// so it answers with that one identity for either.
export const BOT_ID = 'BBOT'
export const BOT_USER_NAME = 'mirage-integ'
export const TEAM_ID = 'T1'
export const TEAM_NAME = 'Kestrel'
