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

import { expect, it } from 'vitest'
import { METHODS } from '../../core/dify/search.ts'
import { VFS_MD } from './dify.ts'

// Twin of test_vfs_md_names_every_search_method.
it('names every search method in VFS.md', () => {
  expect(VFS_MD).toContain(`[--method ${Object.keys(METHODS).join('|')}]`)
})
