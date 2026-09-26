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

import { makeGenericCommands } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { VFSName } from '@struktoai/mirage-core/types'
import type { HfHubAccessor } from '../../../accessor/hf_hub.ts'
import { HF_HUB_IO } from './io.ts'

// The three git-repo VFS. `hf_buckets` is deliberately absent: it is a
// different Hugging Face product (Xet-backed mutable object storage, no
// commits and no revisions) and keeps its own OpenDAL-backed commands.
export const HF_HUB_VFS_NAMES = [VFSName.HF_MODELS, VFSName.HF_DATASETS, VFSName.HF_SPACES] as const

export const HF_HUB_COMMANDS: readonly RegisteredCommand[] = HF_HUB_VFS_NAMES.flatMap((vfs) =>
  makeGenericCommands<HfHubAccessor>(vfs, HF_HUB_IO),
)
