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
import { SharePointAccessor } from './sharepoint.ts'

it('forget drops the site and drive ids', () => {
  const accessor = new SharePointAccessor({ accessToken: 'tok' })
  accessor.siteCache.set('Engineering', 'site-id')
  accessor.driveCache.set('site-id\0Documents', 'drive-id')
  accessor.forget()
  expect([accessor.siteCache.size, accessor.driveCache.size]).toEqual([0, 0])
})
