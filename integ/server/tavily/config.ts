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
import type { PrismaClient } from '../../generated/tavily/index.js'

export type C = PrismaClient

// The one key the fake accepts. Both hosts' installs and the real tvly the
// conformance gate runs send it, so a 401 is reachable only by a wrong key.
export const API_KEY = 'tvly-integ-key'

export const config = parseConfig({
  service: 'tavily',
  schema: schemaFor('tavily'),
  defaultPort: 5111,
  tenantKind: 'pk-column',
})
