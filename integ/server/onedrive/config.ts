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
import type { PrismaClient } from '../../generated/onedrive/index.js'

export type C = PrismaClient

export const config = parseConfig({
  service: 'onedrive',
  schema: schemaFor('onedrive'),
  defaultPort: 5089,
  tenantKind: 'pk-column',
  tenantFromBearer: true,
  // Real Graph accepts simple PUTs up to 4 MiB and a session above that; the
  // kit's default already clears both.
  mintFormat: '{kind}{n}',
})

export const SITE_ID = 'site-main'
export const SITE_NAME = 'Main'
export const DEFAULT_DRIVE = 'default'

// SharePoint (and OneDrive for Business, which is SharePoint underneath)
// rewrites Office documents server-side after an upload: metadata is injected
// into the file, so downloaded bytes differ from uploaded bytes and cTag
// changes without a user write. The real rewrite is an async zip-internal
// edit; the fake models it as a synchronous, idempotent marker append so
// shared-case expectations stay deterministic.
export const OFFICE_EXTENSIONS = ['.pptx', '.docx', '.xlsx']
export const ENRICH_MARKER = '<odsp-metadata/>'

// A Basic account's storage, which a drive's quota facet reports as total.
export const DRIVE_BYTES = 5 * 1024 * 1024 * 1024
