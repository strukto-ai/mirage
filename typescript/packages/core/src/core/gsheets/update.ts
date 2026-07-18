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

import { sheetsBase, type TokenManager, googlePost } from '../google/_client.ts'

export async function batchUpdate(
  tm: TokenManager,
  spreadsheetId: string,
  requestsJson: string,
): Promise<unknown> {
  let payload: unknown
  try {
    payload = JSON.parse(requestsJson)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid JSON: ${msg}. Payload must contain 'requests' key.`)
  }
  if (typeof payload !== 'object' || payload === null || !('requests' in payload)) {
    throw new Error("Payload must contain 'requests' key.")
  }
  const url = `${sheetsBase(tm)}/spreadsheets/${spreadsheetId}:batchUpdate`
  return googlePost(tm, url, payload)
}
