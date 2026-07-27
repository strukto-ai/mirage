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

import { PathSpec, type FsError } from '@struktoai/mirage-core'
import { describe, expect, it } from 'vitest'
import { diskError } from './errors.ts'

function hostError(code: string, hostPath: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: failed, stat '${hostPath}'`) as NodeJS.ErrnoException
  err.code = code
  err.path = hostPath
  return err
}

describe('core/disk diskError', () => {
  it('replaces the host path with the virtual one', () => {
    const spec = PathSpec.fromStrPath('/data/plain/x.txt')
    const out = diskError(
      hostError('ENOTDIR', '/private/var/folders/tmpabc/plain/x.txt'),
      spec,
    ) as FsError
    expect(out.virtualPath).toBe('/data/plain/x.txt')
    expect(out.message).toBe('/data/plain/x.txt')
    expect(out.message).not.toContain('/private/var')
  })

  it('preserves the errno code so the GNU strerror is unchanged', () => {
    const spec = PathSpec.fromStrPath('/data/a.txt')
    const out = diskError(hostError('EEXIST', '/real/a.txt'), spec) as FsError
    expect(out.code).toBe('EEXIST')
  })

  it('leaves an error with no errno code untouched', () => {
    const spec = PathSpec.fromStrPath('/data/a.txt')
    const boom = new Error('boom')
    expect(diskError(boom, spec)).toBe(boom)
  })
})
