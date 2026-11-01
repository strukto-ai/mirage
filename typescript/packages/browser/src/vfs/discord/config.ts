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

import { timeoutShape } from '@struktoai/mirage-core/core/api/config'
import {
  orderedTimes,
  timeRangeOrderError,
  timeRangeShape,
} from '@struktoai/mirage-core/core/time_config'
import type { ConfigOf } from '@struktoai/mirage-core/vfs/secrets'
import { secretSchema, z } from '@struktoai/mirage-core/vfs/secrets'

type HeaderProvider = () => Promise<Record<string, string>> | Record<string, string>

export const DiscordConfig = z
  .object({
    ...timeoutShape,
    ...timeRangeShape,
    proxyUrl: z
      .string()
      .describe(
        "URL of your backend proxy, which forwards to `https://discord.com/api/v10` and attaches the bot token. A path resolves against the page's origin; no query string or fragment.",
      ),
    getHeaders: secretSchema(z.custom<HeaderProvider>((value) => typeof value === 'function'))
      .optional()
      .describe(
        'Function returning extra headers sent with every request to the proxy, such as your own session credential.',
      ),
  })
  .refine(orderedTimes, timeRangeOrderError)

export type DiscordConfig = ConfigOf<typeof DiscordConfig>
