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

import { PathSpec, invalidateAfterWrite } from '@struktoai/mirage-core'

// Buckets have no directory markers, so a write or delete materializes or
// removes directories arbitrarily far up the tree; backends with markers
// refresh ancestors through their marker writes instead.
export async function invalidateAncestors(path: PathSpec): Promise<void> {
  let parent = path.mountPath.slice(0, path.mountPath.lastIndexOf('/'))
  while (parent !== '') {
    await invalidateAfterWrite(PathSpec.fromStrPath(parent))
    parent = parent.slice(0, parent.lastIndexOf('/'))
  }
}
