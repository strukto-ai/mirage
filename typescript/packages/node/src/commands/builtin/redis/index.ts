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

import {
  type RegisteredCommand,
  ResourceName,
  makeFiletypeCommands,
  makeGenericCommands,
} from '@struktoai/mirage-core'
import type { RedisAccessor } from '../../../accessor/redis.ts'
import { read as redisRead } from '../../../core/redis/read.ts'
import { stat as redisStat } from '../../../core/redis/stat.ts'
import { REDIS_IO } from './io.ts'

export const REDIS_COMMANDS: readonly RegisteredCommand[] = [
  ...makeFiletypeCommands<RedisAccessor>({
    resource: ResourceName.REDIS,
    readBytes: redisRead,
    statEntry: redisStat,
  }),
  ...makeGenericCommands<RedisAccessor>(ResourceName.REDIS, REDIS_IO),
]
