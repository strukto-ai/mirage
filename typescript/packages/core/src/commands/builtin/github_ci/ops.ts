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

import type { GitHubCIAccessor } from '../../../accessor/github_ci.ts'
import { read as githubCiRead, stream as githubCiStream } from '../../../core/github_ci/read.ts'
import { readdir as githubCiReaddir } from '../../../core/github_ci/readdir.ts'
import { stat as githubCiStat } from '../../../core/github_ci/stat.ts'
import type { CommandIO } from '../generic_bind/index.ts'

export const GITHUB_CI_CMD_OPS: CommandIO<GitHubCIAccessor> = {
  readdir: githubCiReaddir,
  readBytes: githubCiRead,
  readStream: githubCiStream,
  stat: githubCiStat,
  isMounted: () => true,
  local: false,
}
