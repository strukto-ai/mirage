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

import { slidesBase, type TokenManager, googleGet } from '../google/client.ts'
import { compactJsonBytes } from '../render/json.ts'

/**
 * Every Slides request a Google backend makes, as one object. A core op
 * reaches Slides only through `accessor.slides`. Mirrors Python's
 * `SlidesApi`.
 */
export interface SlidesApi {
  readPresentation(presentationId: string): Promise<Uint8Array>
}

/** The live `SlidesApi`: one token manager, one wire call per method. */
export class SlidesClient implements SlidesApi {
  readonly tokenManager: TokenManager

  constructor(tokenManager: TokenManager) {
    this.tokenManager = tokenManager
  }

  /** Fetch presentation JSON. */
  async readPresentation(presentationId: string): Promise<Uint8Array> {
    const url = `${slidesBase(this.tokenManager)}/presentations/${presentationId}`
    const data = await googleGet(this.tokenManager, url)
    return compactJsonBytes(data)
  }
}
