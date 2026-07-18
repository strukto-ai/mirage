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
import type { RedisAccessor } from '../../../accessor/redis.ts'
import { appendBytes as redisAppend } from '../../../core/redis/append.ts'
import { SCOPE_ERROR } from '../../../core/redis/constants.ts'
import { copy as redisCopy } from '../../../core/redis/copy.ts'
import { create as redisCreate } from '../../../core/redis/create.ts'
import { du as redisDu, duAll as redisDuAll } from '../../../core/redis/du.ts'
import { exists as redisExists } from '../../../core/redis/exists.ts'
import { find as redisFind } from '../../../core/redis/find.ts'
import { mkdir as redisMkdir } from '../../../core/redis/mkdir.ts'
import { read as redisRead } from '../../../core/redis/read.ts'
import { readdir as redisReaddir } from '../../../core/redis/readdir.ts'
import { rename as redisRename } from '../../../core/redis/rename.ts'
import { rmR as redisRmR } from '../../../core/redis/rm.ts'
import { rmdir as redisRmdir } from '../../../core/redis/rmdir.ts'
import { setAttrs as redisSetAttrs } from '../../../core/redis/set_attrs.ts'
import { stat as redisStat } from '../../../core/redis/stat.ts'
import { stream as redisStream } from '../../../core/redis/stream.ts'
import { truncate as redisTruncate } from '../../../core/redis/truncate.ts'
import { unlink as redisUnlink } from '../../../core/redis/unlink.ts'
import { writeBytes as redisWrite } from '../../../core/redis/write.ts'

export const REDIS_CMD_OPS: CommandIO<RedisAccessor> = {
  readdir: redisReaddir,
  readBytes: redisRead,
  readStream: redisStream,
  stat: redisStat,
  isMounted: () => true,
  local: true,
  maxGlobMatches: SCOPE_ERROR,
  write: redisWrite,
  exists: redisExists,
  mkdir: redisMkdir,
  unlink: redisUnlink,
  rmdir: redisRmdir,
  rmR: redisRmR,
  rename: redisRename,
  copy: redisCopy,
  create: redisCreate,
  truncate: redisTruncate,
  append: redisAppend,
  setAttrs: redisSetAttrs,
  find: redisFind,
  duTotal: redisDu,
  duAll: async (accessor, path) => {
    const { entries, total } = await redisDuAll(accessor, path)
    return [entries, total]
  },
}
