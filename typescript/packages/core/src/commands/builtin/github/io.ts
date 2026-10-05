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

import { VFSAdapter } from '../../../vfs/adapter.ts'

import type { GitHubAccessor } from '../../../accessor/github.ts'
import { SCOPE_ERROR } from '../../../core/github/constants.ts'
import { read as githubRead, readStream as githubStream } from '../../../core/github/read.ts'
import { readdir as githubReaddir } from '../../../core/github/readdir.ts'
import { stat as githubStat } from '../../../core/github/stat.ts'
import type { CommandIO } from '../generic_bind/index.ts'

export const IO: CommandIO<GitHubAccessor> = new VFSAdapter<GitHubAccessor>({
  read: { readdir: githubReaddir, readBytes: githubRead, stat: githubStat },
  native: { readStream: githubStream },
  isMounted: () => true,
  local: false,
  maxGlobMatches: SCOPE_ERROR,
}).toCommandIO()
