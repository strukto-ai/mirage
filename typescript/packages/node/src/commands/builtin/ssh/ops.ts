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

import type { CommandIO } from '@struktoai/mirage-core'
import type { SSHAccessor } from '../../../accessor/ssh.ts'
import { SCOPE_ERROR } from '../../../core/disk/constants.ts'
import { copy as sshCopy } from '../../../core/ssh/copy.ts'
import { du as sshDu, duAll as sshDuAll } from '../../../core/ssh/du.ts'
import { exists as sshExists } from '../../../core/ssh/exists.ts'
import { find as sshFind } from '../../../core/ssh/find.ts'
import { mkdir as sshMkdir } from '../../../core/ssh/mkdir.ts'
import { read as sshRead } from '../../../core/ssh/read.ts'
import { readdir as sshReaddir } from '../../../core/ssh/readdir.ts'
import { rename as sshRename } from '../../../core/ssh/rename.ts'
import { rmR as sshRmR } from '../../../core/ssh/rm.ts'
import { rmdir as sshRmdir } from '../../../core/ssh/rmdir.ts'
import { stat as sshStat } from '../../../core/ssh/stat.ts'
import { stream as sshStream } from '../../../core/ssh/stream.ts'
import { unlink as sshUnlink } from '../../../core/ssh/unlink.ts'
import { writeBytes as sshWrite } from '../../../core/ssh/write.ts'

export const SSH_CMD_OPS: CommandIO<SSHAccessor> = {
  readdir: sshReaddir,
  readBytes: sshRead,
  readStream: sshStream,
  stat: sshStat,
  isMounted: () => true,
  local: false,
  maxGlobMatches: SCOPE_ERROR,
  write: sshWrite,
  exists: sshExists,
  mkdir: (accessor, path, parents) => sshMkdir(accessor, path, parents === true),
  unlink: sshUnlink,
  rmdir: sshRmdir,
  rmR: sshRmR,
  rename: sshRename,
  copy: sshCopy,
  find: sshFind,
  duTotal: sshDu,
  duAll: sshDuAll,
}
