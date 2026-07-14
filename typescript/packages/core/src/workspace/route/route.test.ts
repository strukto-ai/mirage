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
import { OpsRegistry } from '../../ops/registry.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { Consumer, SHELL_CONSUMERS, route } from './index.ts'
import { Session } from '../session/session.ts'
import { Workspace } from '../workspace.ts'

function fixture(): { session: Session; ws: Workspace } {
  const ram = new RAMResource()
  const registry = new OpsRegistry()
  registry.registerResource(ram)
  const ws = new Workspace({ '/ram': ram }, { mode: MountMode.WRITE, ops: registry })
  return { session: new Session({ sessionId: 't' }), ws }
}

describe('route', () => {
  it('routes builtins to SESSION', () => {
    const { session, ws } = fixture()
    for (const name of ['cd', 'echo', 'export', 'history', 'test', 'xargs']) {
      expect(route(name, session, ws.registry)).toBe(Consumer.SESSION)
    }
  })

  it('routes unsupported builtins to SESSION', () => {
    const { session, ws } = fixture()
    expect(route('exec', session, ws.registry)).toBe(Consumer.SESSION)
  })

  it('routes namespace commands', () => {
    const { session, ws } = fixture()
    expect(route('ln', session, ws.registry)).toBe(Consumer.NAMESPACE)
    expect(route('readlink', session, ws.registry)).toBe(Consumer.NAMESPACE)
  })

  it('routes user functions to FUNCTION', () => {
    const { session, ws } = fixture()
    session.functions.greet = []
    expect(route('greet', session, ws.registry)).toBe(Consumer.FUNCTION)
  })

  it('builtin shadows a function of the same name', () => {
    const { session, ws } = fixture()
    session.functions.echo = []
    expect(route('echo', session, ws.registry)).toBe(Consumer.SESSION)
  })

  it('function shadows a mount command', () => {
    const { session, ws } = fixture()
    session.functions.cat = []
    expect(route('cat', session, ws.registry)).toBe(Consumer.FUNCTION)
  })

  it('routes registered mount commands to MOUNT', () => {
    const { session, ws } = fixture()
    expect(route('cat', session, ws.registry)).toBe(Consumer.MOUNT)
    expect(route('grep', session, ws.registry)).toBe(Consumer.MOUNT)
  })

  it('routes unregistered names to UNKNOWN', () => {
    const { session, ws } = fixture()
    expect(route('nosuchcmd', session, ws.registry)).toBe(Consumer.UNKNOWN)
  })

  it('only shell consumers resolve globs', () => {
    expect(SHELL_CONSUMERS.has(Consumer.SESSION)).toBe(true)
    expect(SHELL_CONSUMERS.has(Consumer.NAMESPACE)).toBe(true)
    expect(SHELL_CONSUMERS.has(Consumer.FUNCTION)).toBe(true)
    expect(SHELL_CONSUMERS.has(Consumer.MOUNT)).toBe(false)
    expect(SHELL_CONSUMERS.has(Consumer.UNKNOWN)).toBe(false)
  })
})
