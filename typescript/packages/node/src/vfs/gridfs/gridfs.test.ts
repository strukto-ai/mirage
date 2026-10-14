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

import { describe, expect, it } from 'vitest'
import { GridFSVFS } from './gridfs.ts'

// Twin of test_a_bucket_is_one_store_whatever_login_reaches_it.
describe('GridFSVFS storageLocation', () => {
  it('is one store whatever login reaches the bucket', () => {
    const location = (uri: string): string =>
      new GridFSVFS({ uri, database: 'd', bucket: 'b' }).storageLocation()
    const one = location('mongodb://ada:secret@h1:27017,h2:27017/admin?tls=true')
    expect(one).toBe(location('mongodb://bob:other@h1:27017,h2:27017/'))
    expect(one).not.toContain('secret')
  })
})
