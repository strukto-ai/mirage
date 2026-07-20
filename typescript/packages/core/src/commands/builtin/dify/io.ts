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

import type { DifyAccessor } from '../../../accessor/dify.ts'
import { readBytes as difyRead, readStream as difyStream } from '../../../core/dify/read.ts'
import { readdir as difyReaddir } from '../../../core/dify/readdir.ts'
import { stat as difyStat } from '../../../core/dify/stat.ts'
import type { CommandIO } from '../generic_bind/index.ts'

// Dify is read-only, so no write op is wired and the generic byte-mutation
// commands are intentionally absent. stat is the index-only stat, so ls/find
// never issue a per-entry document-detail call.
export const DIFY_IO: CommandIO<DifyAccessor> = {
  readdir: difyReaddir,
  readBytes: difyRead,
  readStream: difyStream,
  stat: difyStat,
  isMounted: () => true,
  local: false,
}
