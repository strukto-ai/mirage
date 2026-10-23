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

import { docsBase, type TokenManager, googleGet } from '../google/client.ts'
import { compactJsonBytes } from '../render/json.ts'

const TABS_CONTENT_PARAM = 'true'

/**
 * Every Docs request a Google backend makes, as one object. A core op
 * reaches Docs only through `accessor.docs`. Mirrors Python's `DocsApi`.
 */
export interface DocsApi {
  readDoc(docId: string): Promise<Uint8Array>
}

/** The live `DocsApi`: one token manager, one wire call per method. */
export class DocsClient implements DocsApi {
  readonly tokenManager: TokenManager

  constructor(tokenManager: TokenManager) {
    this.tokenManager = tokenManager
  }

  /**
   * Fetch full document JSON, every tab included.
   *
   * `documents.get` fills the singleton fields from the first tab and leaves
   * `tabs` empty unless asked otherwise, so without `includeTabsContent` a
   * multi-tab document renders as tab 1 and the rest are absent rather than
   * truncated. Asking for it moves the content under `tabs[]` and leaves
   * `body` empty, which is the shape the VFS prompt documents.
   */
  async readDoc(docId: string): Promise<Uint8Array> {
    const url = `${docsBase(this.tokenManager)}/documents/${docId}`
    const data = await googleGet(this.tokenManager, url, {
      includeTabsContent: TABS_CONTENT_PARAM,
    })
    return compactJsonBytes(data)
  }
}
