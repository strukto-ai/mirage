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

import { sourceFor } from '@struktoai/mirage-core/secrets/registry'
import '../src/onepassword.ts'
import '../src/secrets.ts'

interface Read {
  readonly source: string
  readonly config: Record<string, unknown>
  readonly ref: string
}

// One read through a registered source, as a workspace's would go.
export default {
  async fetch(request: Request): Promise<Response> {
    const { source, config, ref } = (await request.json()) as Read
    try {
      const { configModel, fetch } = sourceFor(source)
      const { fields } = await fetch(configModel.parse(config) as never, ref)
      // Each field's length, never its value: a live read stays here.
      return Response.json({
        fields: Object.fromEntries(Object.entries(fields).map(([key, v]) => [key, v.length])),
      })
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) })
    }
  },
}
