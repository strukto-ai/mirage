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

import { z } from 'zod'
import { timeoutShape } from '../../core/api/config.ts'
import { DEFAULT_TIMEOUT } from '../../core/api/constants.ts'
import { REDACTED_SECRET } from '../constants.ts'
import type { ConfigOf, RedactedSchema } from '../secrets.ts'
import { secretStr } from '../secrets.ts'

// `dsn` is the credential, so it carries the secret marker the redactor
// reads; the rest are the knobs python's `PostgresConfig` declares.
export const PostgresConfig = z.object({
  ...timeoutShape,
  dsn: secretStr().describe(
    "Postgres connection string. The default browser driver connects over Neon's HTTP transport, so a browser mount needs a Neon connection string.",
  ),
  schemas: z
    .array(z.string())
    .readonly()
    .optional()
    .describe(
      'Schemas to show in the tree; others are hidden. Unset shows every schema except `pg_catalog`, `information_schema` and `pg_*`.',
    ),
  defaultRowLimit: z.number().optional().meta({
    description:
      'Rows a windowed read returns when it passes an offset but no limit, and the rows one page of a streamed `rows.jsonl` fetches.',
    default: 1000,
  }),
  maxReadRows: z.number().optional().meta({
    description:
      'Most rows one read returns. A whole read past it is refused, and so is a `head -n` / `tail -n` count past it on a table that long (`File too large`); `wc -l` counts past it.',
    default: 10_000,
  }),
  maxReadBytes: z
    .number()
    .optional()
    .meta({
      description:
        'Most bytes of `rows.jsonl` one read returns; a whole read past it is refused (`File too large`).',
      default: 10 * 1024 * 1024,
    }),
})

export type PostgresConfig = ConfigOf<typeof PostgresConfig>

export function resolvePostgresConfig(config: PostgresConfig) {
  return {
    timeout: config.timeout ?? DEFAULT_TIMEOUT,
    dsn: config.dsn,
    schemas: config.schemas ?? null,
    defaultRowLimit: config.defaultRowLimit ?? 1000,
    maxReadRows: config.maxReadRows ?? 10_000,
    maxReadBytes: config.maxReadBytes ?? 10 * 1024 * 1024,
  }
}

export function redactPostgresConfig(
  config: ReturnType<typeof resolvePostgresConfig>,
): RedactedSchema<typeof PostgresConfig, ReturnType<typeof resolvePostgresConfig>> {
  return { ...config, dsn: REDACTED_SECRET }
}
