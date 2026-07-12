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

import type { PostgresAccessor } from '../../../accessor/postgres.ts'
import { read as postgresRead, readStream as postgresStream } from '../../../core/postgres/read.ts'
import { isDirName, readdir as postgresReaddir } from '../../../core/postgres/readdir.ts'
import { stat as postgresStat } from '../../../core/postgres/stat.ts'
import type { CommandIO } from '../generic_bind/index.ts'

export const POSTGRES_CMD_OPS: CommandIO<PostgresAccessor> = {
  readdir: postgresReaddir,
  readBytes: postgresRead,
  readStream: postgresStream,
  stat: postgresStat,
  isMounted: () => true,
  isDirName: (_accessor, child) => isDirName(child),
  local: false,
}
