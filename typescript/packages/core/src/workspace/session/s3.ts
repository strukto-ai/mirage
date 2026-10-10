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

import { normalizeKeyPrefix, type S3Config } from '../../vfs/s3/config.ts'
import { S3RecordClient } from '../record/s3.ts'
import { RecordSessionStore } from './store.ts'

/**
 * SessionStore backed by per-session S3 objects.
 *
 * One object per session at `{keyPrefix}sessions/{session_id}.json`
 * (the store appends the `sessions/` segment, mirroring the Redis
 * store's `{keyPrefix}sessions` hash). Conditional writes (If-Match
 * on the compare-read's ETag) give the same generation-CAS contract
 * as the Redis Lua script, so the S3 control plane is safe for the
 * same multi-process sharing. Works on any S3-compatible backend that
 * honors conditional PUTs. Mirrors the Python S3SessionStore.
 */
export class S3SessionStore extends RecordSessionStore {
  constructor(config: S3Config) {
    super(new S3RecordClient(config, `${normalizeKeyPrefix(config.keyPrefix) ?? ''}sessions/`))
  }
}
