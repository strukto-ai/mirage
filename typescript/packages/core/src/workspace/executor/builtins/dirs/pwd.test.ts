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
import { SessionState } from '../../../session/session.ts'
import { changeDir } from '../../../session/shell_dirs.ts'
import { handlePwd } from './pwd.ts'

const DEC = new TextDecoder()

function session(): SessionState {
  const s = new SessionState({ sessionId: 's1' })
  changeDir(s, '/data/deep/real', '/data/lk')
  return s
}

describe('handlePwd', () => {
  it('prints the logical cwd by default and the physical one under -P', () => {
    const [out, io, node] = handlePwd([], session())
    expect(DEC.decode(out as Uint8Array)).toBe('/data/lk\n')
    expect(io.exitCode).toBe(0)
    expect(node.command).toBe('pwd')
    const [phys] = handlePwd(['-P'], session())
    expect(DEC.decode(phys as Uint8Array)).toBe('/data/deep/real\n')
  })

  it('reads set -P as the default and lets -L override it', () => {
    const s = session()
    s.shellOptions.physical = true
    const [out] = handlePwd([], s)
    expect(DEC.decode(out as Uint8Array)).toBe('/data/deep/real\n')
    const [logical] = handlePwd(['-L'], s)
    expect(DEC.decode(logical as Uint8Array)).toBe('/data/lk\n')
  })

  it('ignores operands and refuses unknown options', () => {
    const [out, io] = handlePwd(['extra'], session())
    expect(DEC.decode(out as Uint8Array)).toBe('/data/lk\n')
    expect(io.exitCode).toBe(0)
    const [none, bad] = handlePwd(['-x'], session())
    expect(none).toBeNull()
    expect(bad.exitCode).toBe(2)
    expect(DEC.decode(bad.stderr as Uint8Array)).toBe(
      'pwd: -x: invalid option\npwd: usage: pwd [-LP]\n',
    )
  })
})
