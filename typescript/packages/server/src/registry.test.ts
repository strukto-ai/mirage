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

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { DiskRecordClient, loadPolicyFile, Workspace } from '@struktoai/mirage-node'
import { newWorkspaceId } from '@struktoai/mirage-core/utils/ids'
import { DaemonConfigError } from './daemon_config.ts'
import { MAX_SESSIONS } from './constants.ts'
import {
  ENV_GRACEFUL_TIMEOUT,
  ENV_HOME,
  ENV_MAX_LINE_SECONDS,
  ENV_MAX_ENV,
  ENV_MAX_MEMORY,
  ENV_MAX_PROCESSES,
  ENV_MAX_SESSIONS,
  ENV_MAX_WORKSPACES,
} from './env.ts'
import {
  Claim,
  Forget,
  resolveGracefulTimeout,
  resolveCeilings,
  resolveMaxSessions,
  resolveMaxWorkspaces,
  resolvePolicyFile,
  WorkspaceRegistry,
} from './registry.ts'
import type { Policy } from '@struktoai/mirage-core/policy/base'
import type { WorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/base'
import { RAMWorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/ram'
import type { CommandContext, VfsContext } from '@struktoai/mirage-core/policy/types'

describe('newWorkspaceId', () => {
  it('mints canonical UUIDv7 ids', () => {
    const id = newWorkspaceId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('resolvePolicyFile', () => {
  it('reads an absolute policy_file as written, a relative one next to config.toml', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mirage-home-'))
    const elsewhere = await mkdtemp(join(tmpdir(), 'mirage-policy-'))
    try {
      await writeFile(join(elsewhere, 'policy.yaml'), 'pre_command: []\n')
      await writeFile(join(home, 'near.yaml'), 'post_command: []\n')
      const env = { [ENV_HOME]: home }
      await writeFile(
        join(home, 'config.toml'),
        `[daemon]\npolicy_file = "${join(elsewhere, 'policy.yaml')}"\n`,
      )
      expect(Object.keys(resolvePolicyFile(loadPolicyFile, undefined, env))).toEqual(['preCommand'])
      await writeFile(join(home, 'config.toml'), '[daemon]\npolicy_file = "near.yaml"\n')
      expect(Object.keys(resolvePolicyFile(loadPolicyFile, undefined, env))).toEqual([
        'postCommand',
      ])
    } finally {
      await rm(home, { recursive: true, force: true })
      await rm(elsewhere, { recursive: true, force: true })
    }
  })
})

describe('WorkspaceRegistry', () => {
  it('add/get/list/remove', async () => {
    const r = new WorkspaceRegistry()
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    const entry = r.add(ws)
    expect(r.has(entry.id)).toBe(true)
    expect(r.list()).toHaveLength(1)
    await r.remove(entry.id)
    expect(r.has(entry.id)).toBe(false)
  })

  it('builds nothing under a stopped id while it is deleted, and deletes none being built', async () => {
    const r = new WorkspaceRegistry()
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const store = {
      drop: () => gate,
      execution: () => ({ holder: () => Promise.resolve(null) }),
    } as unknown as WorkspaceStateStore
    const deleting = r.forget('w', null, null, store)
    expect(await r.creating('w', 'a', (admitted) => Promise.resolve(admitted))).toBe(false)
    release()
    expect(await deleting).toBe(Forget.Done)
    const built = await r.creating('w', 'a', async (admitted) => {
      expect(await r.forget('w', null, null, store)).toBe(Forget.Busy)
      return admitted
    })
    expect(built).toBe(true)
  })

  it('keeps a workspace made under the id while its delete waited', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'configs-'))
    try {
      const r = new WorkspaceRegistry({ configs: new DiskRecordClient(dir, 'configs') })
      await r.saveConfig('w', { mounts: { '/': { vfs: 'ram' } } })
      let dropped = false
      const store = {
        drop: () => {
          dropped = true
          return Promise.resolve()
        },
        execution: () => ({ holder: () => Promise.resolve(null) }),
      } as unknown as WorkspaceStateStore
      const found = { mounts: { '/': { vfs: 'disk' } } }
      expect(await r.forget('w', null, found, store)).toBe(Forget.Gone)
      expect(dropped).toBe(false)
      expect(await r.savedConfig('w', null)).not.toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps a workspace another server runs', async () => {
    const r = new WorkspaceRegistry()
    const store = new RAMWorkspaceStateStore()
    expect(await store.execution('w').lease('other-daemon')).toBeNull()
    expect(await r.forget('w', null, null, store)).toBe(Forget.Held)
    expect(await store.execution('w').holder()).toBe('other-daemon')
  })

  it('joins an overlapping remove instead of deleting the id again', async () => {
    // A second deletion of its own would stop the runner again, then
    // release the id after a create had reused it.
    const r = new WorkspaceRegistry()
    const entry = r.add(new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE }), 'w')
    const stop = vi.spyOn(entry.runner, 'stop')
    const [first, second] = await Promise.all([r.remove('w'), r.remove('w')])
    expect(first).toBe(entry)
    expect(second).toBe(entry)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(r.has('w')).toBe(false)
  })

  it("hands a server policy the owner's account", async () => {
    const accounts = new Set<string | null>()
    const seen: Policy = {
      preCommand(ctx: CommandContext) {
        accounts.add(ctx.caller?.account ?? '')
        return null
      },
      preVfs(ctx: VfsContext) {
        accounts.add(ctx.caller?.account ?? '')
        return null
      },
    }
    const r = new WorkspaceRegistry({ policies: [seen] })
    const entry = r.add(
      new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE }),
      'mine',
      'alice',
    )
    try {
      expect((await entry.runner.ws.shell('echo hi > /a')).exitCode).toBe(0)
      expect(accounts).toEqual(new Set(['alice']))
    } finally {
      await r.closeAll()
    }
  })

  it('rejects duplicate ids', () => {
    const r = new WorkspaceRegistry()
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    r.add(ws, 'fixed')
    const ws2 = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    expect(() => r.add(ws2, 'fixed')).toThrow(/already exists/)
  })

  it('trips exitEvent after idleGraceSeconds when last workspace removed', async () => {
    vi.useFakeTimers()
    let tripped = false
    const r = new WorkspaceRegistry({
      idleGraceSeconds: 0.05,
      onIdleExit: () => {
        tripped = true
      },
    })
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    const entry = r.add(ws)
    await r.remove(entry.id)
    await vi.advanceTimersByTimeAsync(60)
    expect(tripped).toBe(true)
    vi.useRealTimers()
  })
})

describe('WorkspaceRegistry accounts', () => {
  const ram = () => new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })

  it('shows an account only the workspaces it owns', async () => {
    const r = new WorkspaceRegistry()
    const mine = r.add(ram(), 'mine', 'alice')
    r.add(ram(), 'theirs', 'bob')
    r.add(ram(), 'nobodys')
    expect(r.visible('mine', 'alice')).toBe(mine)
    expect(r.visible('theirs', 'alice')).toBeNull()
    expect(r.visible('nobodys', 'alice')).toBeNull()
    expect(r.visible('missing', 'alice')).toBeNull()
    expect(r.visible('theirs', null)).not.toBeNull()
    await r.closeAll()
  })

  it('refuses a caller without an account when accounts are required', async () => {
    const r = new WorkspaceRegistry({ accountsRequired: true })
    r.add(ram(), 'w', 'alice')
    expect(r.visible('w', null)).toBeNull()
    expect(await r.allows('w', null, Date.now() / 1000)).toBe(false)
    expect(r.visible('w', 'alice')).not.toBeNull()
    await r.closeAll()
  })

  it('keeps a claim past the registry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owners-'))
    try {
      const owners = new DiskRecordClient(dir, 'owners')
      const first = new WorkspaceRegistry({ owners })
      expect(await first.claim('w', 'alice', false)).toBe(Claim.New)
      first.add(ram(), 'w', 'alice')
      await first.closeAll()
      // A restarted daemon: nothing is live, the claim still is.
      const second = new WorkspaceRegistry({ owners })
      const now = Date.now() / 1000
      expect(await second.allows('w', 'alice', now)).toBe(true)
      expect(await second.allows('w', 'bob', now)).toBe(false)
      expect(await second.claim('w', 'bob', false)).toBe(Claim.Taken)
      expect(await second.claim('w', 'alice', false)).toBe(Claim.Held)
      expect(await second.claim('w', null, false)).toBe(Claim.Held)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('releases the claim on delete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owners-'))
    try {
      const r = new WorkspaceRegistry({ owners: new DiskRecordClient(dir, 'owners') })
      expect(await r.claim('w', 'alice', false)).toBe(Claim.New)
      r.add(ram(), 'w', 'alice')
      await r.remove('w')
      expect(await r.claim('w', 'bob', false)).toBe(Claim.New)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('leaves stored state without an owner to no account', async () => {
    // State written before accounts were required names no owner, so the
    // first account to create its id would load another caller's sessions.
    const dir = await mkdtemp(join(tmpdir(), 'owners-'))
    try {
      const r = new WorkspaceRegistry({ owners: new DiskRecordClient(dir, 'owners') })
      expect(await r.claim('w', 'alice', true)).toBe(Claim.Taken)
      expect(await r.claim('fresh', 'alice', false)).toBe(Claim.New)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('frees the id when a claim is released', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owners-'))
    try {
      const r = new WorkspaceRegistry({ owners: new DiskRecordClient(dir, 'owners') })
      expect(await r.claim('w', 'alice', false)).toBe(Claim.New)
      await r.release('w')
      expect(await r.claim('w', 'bob', false)).toBe(Claim.New)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps a stopping id reserved until the runner stops', async () => {
    const r = new WorkspaceRegistry()
    const entry = r.add(ram(), 'w')
    let stopping = (): void => undefined
    const held = new Promise<void>((resolve) => {
      stopping = resolve
    })
    const stop = entry.runner.stop.bind(entry.runner)
    vi.spyOn(entry.runner, 'stop').mockImplementation(async (options) => {
      await held
      await stop(options)
    })
    const stopped = r.stop('w')
    expect(r.has('w')).toBe(false)
    expect(r.removing('w')).toBe(true)
    expect(() => r.add(ram(), 'w')).toThrow(/already exists/)
    stopping()
    expect(await stopped).toBe(entry)
    expect(r.removing('w')).toBe(false)
    r.add(ram(), 'w')
    await r.closeAll()
  })

  it('reads after the runner stops and before the id is released', async () => {
    const r = new WorkspaceRegistry()
    const entry = r.add(ram(), 'w')
    let stopped = false
    const stop = entry.runner.stop.bind(entry.runner)
    vi.spyOn(entry.runner, 'stop').mockImplementation(async (options) => {
      await stop(options)
      stopped = true
    })
    let reading = (): void => undefined
    const started = new Promise<void>((resolve) => {
      reading = resolve
    })
    let read = (): void => undefined
    const done = new Promise<void>((resolve) => {
      read = resolve
    })
    const seen: boolean[] = []
    const stopping = r.stop('w', async () => {
      seen.push(stopped, r.removing('w'))
      reading()
      await done
    })
    await started
    expect(seen).toEqual([true, true])
    expect(() => r.add(ram(), 'w')).toThrow(/already exists/)
    read()
    expect(await stopping).toBe(entry)
    expect(r.removing('w')).toBe(false)
    await r.closeAll()
  })

  it('releases the id when the stop read fails', async () => {
    const r = new WorkspaceRegistry()
    const entry = r.add(ram(), 'w')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await r.stop('w', () => Promise.reject(new Error('store down')))).toBe(entry)
      expect(r.removing('w')).toBe(false)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
    r.add(ram(), 'w')
    await r.closeAll()
  })

  it('answers a live workspace only for records made since its creation', async () => {
    // A workspace created under a deleted one's id must not read the jobs
    // the deleted one left.
    const r = new WorkspaceRegistry({ accountsRequired: true })
    const entry = r.add(ram(), 'w', 'bob')
    expect(await r.allows('w', 'bob', entry.createdAt - 1)).toBe(false)
    expect(await r.allows('w', 'bob', entry.createdAt)).toBe(true)
    await r.closeAll()
  })
})

describe('max_workspaces', () => {
  it('counts builds in flight against the cap', async () => {
    const r = new WorkspaceRegistry({ maxWorkspaces: 3 })
    r.add(new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE }), 'a')
    await r.creating('b', 'one', async () => {
      expect(r.hasRoom()).toBe(true)
      r.add(new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE }), 'b')
      await r.creating('c', 'two', async () => {
        expect(r.hasRoom()).toBe(true)
        await r.creating('d', 'three', () => {
          expect(r.hasRoom()).toBe(false)
          return Promise.resolve()
        })
      })
    })
    expect(new WorkspaceRegistry().hasRoom()).toBe(true)
    await r.remove('a')
    await r.remove('b')
  })

  it('reads the env, then the config file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mirage-max-'))
    try {
      expect(resolveMaxWorkspaces(undefined, { [ENV_HOME]: home })).toBeNull()
      await writeFile(join(home, 'config.toml'), '[daemon]\nmax_workspaces = 8\n')
      expect(resolveMaxWorkspaces(undefined, { [ENV_HOME]: home })).toBe(8)
      const env = { [ENV_HOME]: home, [ENV_MAX_WORKSPACES]: '32' }
      expect(resolveMaxWorkspaces(undefined, env)).toBe(32)
      expect(resolveMaxWorkspaces(4, env)).toBe(4)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it.each(['0', 'lots', '1.5'])('refuses %s', (value) => {
    expect(() => resolveMaxWorkspaces(undefined, { [ENV_MAX_WORKSPACES]: value })).toThrow(
      DaemonConfigError,
    )
  })
})

describe('resolveMaxSessions', () => {
  it('reads the env then config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mir-sessions-'))
    try {
      expect(resolveMaxSessions(undefined, { [ENV_HOME]: home })).toBe(MAX_SESSIONS)
      expect(resolveMaxSessions(undefined, { [ENV_HOME]: home }, 4)).toBe(4)
      await writeFile(join(home, 'config.toml'), '[daemon]\nmax_sessions = 8\n')
      expect(resolveMaxSessions(undefined, { [ENV_HOME]: home })).toBe(8)
      expect(() => resolveMaxSessions(undefined, { [ENV_MAX_SESSIONS]: '0' })).toThrow(
        /max_sessions/,
      )
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('resolveCeilings', () => {
  it('reads each setting from the env then config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mir-ceilings-'))
    try {
      expect(resolveCeilings({}, { [ENV_HOME]: home })).toEqual({
        maxMemory: null,
        maxProcesses: null,
        maxLineSeconds: null,
        maxEnv: null,
      })
      await writeFile(
        join(home, 'config.toml'),
        '[daemon]\nmax_memory = "16MB"\nmax_processes = 32\nmax_env = "64KB"\n',
      )
      expect(resolveCeilings({}, { [ENV_HOME]: home })).toEqual({
        maxMemory: 16 << 20,
        maxProcesses: 32,
        maxLineSeconds: null,
        maxEnv: 64 << 10,
      })
      expect(
        resolveCeilings({ maxProcesses: 4 }, { [ENV_HOME]: home, [ENV_MAX_LINE_SECONDS]: '90' }),
      ).toEqual({ maxMemory: 16 << 20, maxProcesses: 4, maxLineSeconds: 90, maxEnv: 64 << 10 })
      for (const [env, bad, key] of [
        [ENV_MAX_MEMORY, 'lots', 'max_memory'],
        [ENV_MAX_MEMORY, '0', 'max_memory'],
        [ENV_MAX_ENV, 'lots', 'max_env'],
        [ENV_MAX_PROCESSES, '0', 'max_processes'],
        [ENV_MAX_LINE_SECONDS, '-1', 'max_line_seconds'],
        [ENV_MAX_LINE_SECONDS, 'Infinity', 'max_line_seconds'],
      ] as const) {
        expect(() => resolveCeilings({}, { [ENV_HOME]: home, [env]: bad })).toThrow(key)
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('resolveGracefulTimeout', () => {
  it('reads the env then config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mir-drain-'))
    try {
      expect(resolveGracefulTimeout(undefined, { [ENV_HOME]: home })).toBe(0)
      await writeFile(join(home, 'config.toml'), '[daemon]\ngraceful_timeout = 25\n')
      expect(resolveGracefulTimeout(undefined, { [ENV_HOME]: home })).toBe(25)
      expect(
        resolveGracefulTimeout(undefined, { [ENV_HOME]: home, [ENV_GRACEFUL_TIMEOUT]: '2.5' }),
      ).toBe(2.5)
      expect(resolveGracefulTimeout(0, { [ENV_GRACEFUL_TIMEOUT]: '9' })).toBe(0)
      for (const bad of ['-1', 'soon', 'Infinity']) {
        expect(() => resolveGracefulTimeout(undefined, { [ENV_GRACEFUL_TIMEOUT]: bad })).toThrow(
          /graceful_timeout/,
        )
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('drain', () => {
  it('lets running lines finish and cancels the rest', async () => {
    const registry = new WorkspaceRegistry({ idleGraceSeconds: 10 })
    const quick = registry.add(new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE }), 'q')
    const slow = registry.add(new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE }), 's')
    const short = quick.runner.ws.shell('sleep 0.2; echo done')
    const long = slow.runner.ws.shell('sleep 30').then(
      () => 'ended',
      () => 'cancelled',
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    const started = Date.now()
    await registry.drain(1)
    expect(registry.draining).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
    expect((await short).stdoutText).toBe('done\n')
    expect(await long).toBe('cancelled')
    await registry.closeAll()
  })
})

describe('drain deadline', () => {
  it('counts a capture it waits behind', async () => {
    const registry = new WorkspaceRegistry({ idleGraceSeconds: 10 })
    const entry = registry.add(new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE }), 'w')
    const ws = entry.runner.ws
    const line = ws.shell('sleep 30').then(
      () => 'ended',
      () => 'cancelled',
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    const snapshot = ws.quiesced(() => Promise.resolve(), 30).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const started = Date.now()
    await registry.drain(0.3)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(await line).toBe('cancelled')
    await snapshot
    await registry.closeAll()
  })
})
