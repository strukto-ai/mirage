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

// Drop this file into `.opencode/plugins/mirage.ts` of any project and run
// `opencode`. OpenCode auto-discovers plugin files and merges their `tool`
// dict over its built-ins, so `read`, `write`, `edit`, `ls`, `bash`, `glob`,
// and `grep` will operate on the Mirage workspace instead of the local disk.

import { MountMode, OpsRegistry, RAMResource, Workspace } from '@struktoai/mirage-node'
import { miragePlugin } from '@struktoai/mirage-agents/opencode'

const ram = new RAMResource()
const ops = new OpsRegistry()
for (const op of ram.ops()) ops.register(op)
const ws = new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })

export default miragePlugin(ws)
