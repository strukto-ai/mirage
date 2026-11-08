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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { YieldBudget } from '../../io/yield_budget.ts'
import type { Action, Policy, SessionContext } from '../../policy/index.ts'
import { SESSION_SCOPED } from '../../policy/mixin.ts'
import type { PolicyMethod } from '../../policy/types.ts'
import { ShellTask } from '../../rs/shell.ts'
import { DEFAULT_VISIBILITY } from '../../types.ts'
import { Workspace } from '../workspace/workspace.ts'
import { seedVar } from './state.ts'

const DEC = new TextDecoder()

describe('drive', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pauses a long value operator where a cancel lands', async () => {
    const ws = new Workspace({}, { maxEnv: null })
    const controller = new AbortController()
    let pauses = 0
    try {
      await ws.shell('shopt -s extglob')
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const resumed = ShellTask.prototype.answerResumed
      vi.spyOn(ShellTask.prototype, 'answerResumed').mockImplementation(function (this: ShellTask) {
        pauses += 1
        if (pauses === 1) controller.abort()
        resumed.call(this)
      })
      const line = ws.shell('x=${X//+(?)/x}; touched=yes', {
        signal: controller.signal,
        env: { X: 'a'.repeat(2_000_000) },
      })
      await expect(line).rejects.toMatchObject({ name: 'AbortError' })
      expect(pauses).toBeGreaterThanOrEqual(1)
      expect(pauses).toBeLessThan(20)
      vi.restoreAllMocks()
      const result = await ws.shell('printf "%s\\n" "${touched-unset}"')
      expect(DEC.decode(result.stdout)).toBe('unset\n')
    } finally {
      await ws.close()
    }
  })

  it('hides the names of a profile changed while it ran', async () => {
    const ws = new Workspace({}, { maxEnv: null })
    const session = ws.getSession(ws.defaultSessionId)
    const hidden = { ...DEFAULT_VISIBILITY, vars: { names: ['TOKEN'], patterns: [] } }
    try {
      await ws.shell('shopt -s extglob; TOKEN=t')
      seedVar(session, 'X', 'a'.repeat(50_000))
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const run = YieldBudget.prototype.run
      vi.spyOn(YieldBudget.prototype, 'run').mockImplementation(function (this: YieldBudget) {
        session.visibility = hidden
        return run.call(this)
      })
      const result = await ws.shell('x=${X//+(?)/x}; echo "${TOKEN-unset}"')
      expect(session.visibility).toBe(hidden)
      expect(DEC.decode(result.stdout)).toBe('unset\n')
    } finally {
      await ws.close()
    }
  })

  it('asks a policy added mid-task about the writes after it', async () => {
    const ws = new Workspace({}, { maxEnv: null })
    const session = ws.getSession(ws.defaultSessionId)
    const denyY: Policy = {
      preSession(ctx: SessionContext): Action | null {
        return ctx.key === 'Y' ? { kind: 'deny', reason: 'Y refused' } : null
      },
    }
    let added = false
    try {
      await ws.shell('shopt -s extglob')
      seedVar(session, 'X', 'a'.repeat(50_000))
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const run = YieldBudget.prototype.run
      vi.spyOn(YieldBudget.prototype, 'run').mockImplementation(function (this: YieldBudget) {
        if (!added) {
          added = true
          ws.registry.policies.add(denyY)
        }
        return run.call(this)
      })
      await ws.shell(': "${Y:=${X//+(?)/x}}"')
      const result = await ws.shell('echo "${Y-unset}"')
      expect(added).toBe(true)
      expect(DEC.decode(result.stdout)).toBe('unset\n')
    } finally {
      await ws.close()
    }
  })

  it('lets a policy read the session while a task waits', async () => {
    const ws = new Workspace({}, { maxEnv: null })
    const session = ws.getSession(ws.defaultSessionId)
    const flagged = {
      [SESSION_SCOPED]: true as const,
      wantsFor(_method: PolicyMethod, sessionId: string): Promise<boolean> {
        return Promise.resolve(ws.getSession(sessionId).env.FLAG === 'on')
      },
      preSession(): Action | null {
        return null
      },
    }
    ws.registry.policies.add(flagged)
    try {
      await ws.shell('shopt -s extglob')
      seedVar(session, 'X', 'a'.repeat(50_000))
      const result = await ws.shell(': "${Y:=${X//+(?)/x}}"; echo "${#Y}"')
      expect(DEC.decode(result.stderr)).toBe('')
      expect(DEC.decode(result.stdout)).toBe('1\n')
    } finally {
      await ws.close()
    }
  })

  it('never pauses a short value operator', async () => {
    const ws = new Workspace({})
    const resumed = vi.spyOn(ShellTask.prototype, 'answerResumed')
    try {
      const result = await ws.shell('x=hello; echo "${x//l/L} ${x^^[lo]}"')
      expect(DEC.decode(result.stdout)).toBe('heLLo heLLO\n')
      expect(resumed).not.toHaveBeenCalled()
    } finally {
      await ws.close()
    }
  })
})
