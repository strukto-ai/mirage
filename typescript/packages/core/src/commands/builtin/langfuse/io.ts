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

import type { LangfuseAccessor } from '../../../accessor/langfuse.ts'
import { read as langfuseRead } from '../../../core/langfuse/read.ts'
import { isDirName, readdir as langfuseReaddir } from '../../../core/langfuse/readdir.ts'
import { stat as langfuseStat } from '../../../core/langfuse/stat.ts'
import type { CommandIO } from '../generic_bind/index.ts'
import { streamFromBytes } from '../utils/wrap.ts'

export const LANGFUSE_IO: CommandIO<LangfuseAccessor> = {
  readdir: langfuseReaddir,
  readBytes: langfuseRead,
  readStream: (a, p, i) => streamFromBytes(langfuseRead, a, p, i),
  stat: langfuseStat,
  isMounted: () => true,
  isDirName: (_accessor, child) => isDirName(child),
  local: false,
}
