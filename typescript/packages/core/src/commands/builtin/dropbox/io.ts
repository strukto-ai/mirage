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

import type { DropboxAccessor } from '../../../accessor/dropbox.ts'
import { du as dropboxDu, duAll as dropboxDuAll } from '../../../core/dropbox/du.ts'
import { read as dropboxRead, stream as dropboxStream } from '../../../core/dropbox/read.ts'
import { isDirName, readdir as dropboxReaddir } from '../../../core/dropbox/readdir.ts'
import { stat as dropboxStat } from '../../../core/dropbox/stat.ts'
import type { CommandIO } from '../generic_bind/index.ts'

export const DROPBOX_IO: CommandIO<DropboxAccessor> = {
  readdir: dropboxReaddir,
  readBytes: dropboxRead,
  readStream: dropboxStream,
  stat: dropboxStat,
  isMounted: () => true,
  isDirName: (_accessor, child) => isDirName(child),
  local: false,
  duTotal: dropboxDu,
  duAll: dropboxDuAll,
}
