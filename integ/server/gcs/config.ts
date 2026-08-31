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
import type { PrismaClient } from '../../generated/gcs/index.js'

export type C = PrismaClient

// tenantKind is pk-column with no bearer: Cloud Storage reached through
// STORAGE_EMULATOR_HOST is unauthenticated, so there is no credential a tenant
// could be read off. Every row still carries the column, because a model
// without one blocks a scoped /reset; runs separate on `/_run/<id>`, which
// rides in the base URL and so survives a vendor SDK that builds its own
// requests.
export const config = parseConfig({
  service: 'gcs',
  schema: schemaFor('gcs'),
  // 5094 is the one gap left in the 5086-5099 block.
  defaultPort: 5094,
  tenantKind: 'pk-column',
  mintFormat: '{n}',
})

// What an object reports when nothing on the wire said. The CLI's `upload`
// sends `application/octet-stream` explicitly and the Go client that BigQuery's
// extract job runs on sends `text/plain; charset=utf-8`, so this is only ever
// reached by a caller that sent no type at all.
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

// The project a bucket is filed under when the creator named none. `buckets
// list` filters on it, so a bucket created without one still has to be
// listable by the CLI, which always sends its own.
export const DEFAULT_PROJECT = 'default-project'
