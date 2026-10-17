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
import { materialize } from '../../../../io/types.ts'
import { Observer } from '../../../../observe/observer.ts'
import { MountMode } from '../../../../types.ts'
import { MountRegistry } from '../../../mount/registry.ts'
import { SessionState } from '../../../session/session.ts'
import { handleHistory } from './history.ts'

const DEC = new TextDecoder()

function recording(): MountRegistry {
  const registry = new MountRegistry({}, MountMode.READ)
  registry.observer = new Observer()
  return registry
}

function session(): SessionState {
  return new SessionState({ sessionId: 'test' })
}

describe('handleHistory', () => {
  it('reports a usage error with status 2', async () => {
    const [, io, node] = await handleHistory(recording(), ['-x'], session())
    const err = DEC.decode(await materialize(io.stderr))
    expect(io.exitCode).toBe(2)
    expect(node.exitCode).toBe(2)
    expect(err.startsWith('bash: history: -x: invalid option\n')).toBe(true)
    expect(err).toContain('history: usage: history [-c]')
  })

  it('reports when the workspace has no recorder', async () => {
    const [, io] = await handleHistory(new MountRegistry({}, MountMode.READ), [], session())
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(await materialize(io.stderr))).toBe(
      'bash: history: not enabled for this workspace\n',
    )
  })

  it('-s stores its words as one entry the listing shows', async () => {
    const registry = recording()
    const [stream, io, node] = await handleHistory(registry, ['-s', 'echo', 'hi'], session())
    expect(stream).toBeNull()
    expect(io.exitCode).toBe(0)
    expect(node.command).toBe('history')
    const [listed] = await handleHistory(registry, [], session())
    expect(DEC.decode(await materialize(listed))).toBe('1  echo hi\n')
  })

  it('-p prints its words without storing them', async () => {
    const registry = recording()
    const [stream] = await handleHistory(registry, ['-p', 'a', 'b'], session())
    expect(DEC.decode(await materialize(stream))).toBe('a\nb\n')
    const [listed] = await handleHistory(registry, [], session())
    expect(DEC.decode(await materialize(listed))).toBe('')
  })

  it('puts an out-of-range offset on the node', async () => {
    const [, io, node] = await handleHistory(recording(), ['-d', '5'], session())
    const err = 'bash: history: 5: history position out of range\n'
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(await materialize(io.stderr))).toBe(err)
    expect(node.exitCode).toBe(1)
    expect(DEC.decode(node.stderr)).toBe(err)
  })
})
