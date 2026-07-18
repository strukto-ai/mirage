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

import type { GmailAccessor } from '../../../accessor/gmail.ts'
import { read as gmailRead } from '../../../core/gmail/read.ts'
import { isDirName, readdir as gmailReaddir } from '../../../core/gmail/readdir.ts'
import { stat as gmailStat } from '../../../core/gmail/stat.ts'
import type { CommandIO } from '../generic_bind/index.ts'
import { streamFromBytes } from '../utils/wrap.ts'

export const GMAIL_IO: CommandIO<GmailAccessor> = {
  readdir: gmailReaddir,
  readBytes: gmailRead,
  readStream: (a, p, i) => streamFromBytes(gmailRead, a, p, i),
  stat: gmailStat,
  isMounted: () => true,
  isDirName: (_accessor, child) => isDirName(child),
  local: false,
}
