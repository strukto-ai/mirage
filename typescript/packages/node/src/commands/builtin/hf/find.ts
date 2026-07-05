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

import { command, findGeneric, metadataProvision, specOf } from '@struktoai/mirage-core'
import { HF_RESOURCES, type HfAccessor } from '../../../accessor/hf.ts'
import { find as hfFind } from '../../../core/hf/find.ts'

export const HF_FIND = command({
  name: 'find',
  resource: [...HF_RESOURCES],
  spec: specOf('find'),
  provision: metadataProvision,
  fn: (accessor: HfAccessor, paths, texts, opts) =>
    findGeneric(paths, texts, opts, (root, options) => hfFind(accessor, root, options)),
})
