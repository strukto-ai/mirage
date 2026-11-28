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

import type { ConfigOf } from '../../vfs/secrets.ts'
import { secretStr, z } from '../../vfs/secrets.ts'
import { DEFAULT_API_BASE_URL, DEFAULT_TIMEOUT } from './constants.ts'

export const TavilyConfig = z.object({
  apiKey: secretStr()
    .optional()
    .describe(
      "Tavily API key (`tvly-...`). Unset searches and extracts keyless, within Tavily's fair-use cap; crawl, map and research need one.",
    ),
  baseUrl: z.string().optional().meta({
    description: 'Tavily API root; override to point at a fake or proxy.',
    default: DEFAULT_API_BASE_URL,
  }),
  timeout: z.number().positive().optional().meta({
    description:
      'Seconds a request may wait to connect, or between two reads of its answer. A crawl answers only once it has walked the site, so the default is the 150 seconds the longest call may take.',
    default: DEFAULT_TIMEOUT,
  }),
})

export type TavilyConfig = ConfigOf<typeof TavilyConfig>
