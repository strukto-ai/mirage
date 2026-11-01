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

import { openStreamSync } from '../../../../rs/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

/** serde_json's own parse error, or null for a valid document. */
export function serdeMessage(text: string): string | null {
  const stream = openStreamSync('json_validate', {})
  try {
    stream.feed(ENC.encode(text))
    return DEC.decode(stream.finish()) || null
  } finally {
    stream.close()
  }
}
