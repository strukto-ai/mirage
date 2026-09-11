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

import { isDeepStrictEqual } from 'node:util'
import { readFileSync } from 'node:fs'
import {
  Workspace as NodeWorkspace,
  buildResource as buildNodeResource,
  registerResourceFactory as registerNodeResource,
} from '@struktoai/mirage-node'
import {
  Workspace as BrowserWorkspace,
  buildResource as buildBrowserResource,
  registerResourceFactory as registerBrowserResource,
} from '@struktoai/mirage-browser'
import { MountMode } from '@struktoai/mirage-core/types'
import type { Resource } from '@struktoai/mirage-core/resource/base'
import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import type {
  Workspace,
  WorkspaceOptions,
} from '@struktoai/mirage-core/workspace/workspace/workspace'
import { parseSessionProfile } from '@struktoai/mirage-core/policy/profile'
import { classify } from '@struktoai/mirage-core/errors/classify'
import { ScriptSource } from '@struktoai/mirage-core/runtime/routing/types'
import type { Policy } from '@struktoai/mirage-core/policy/base'
import { CLISpec } from '@struktoai/mirage-core/commands/cli/types'
import { runWithSession } from '@struktoai/mirage-core/context/session_context'

interface ResourceConfig {
  resource: string
  config?: Record<string, unknown>
}

interface Case {
  id: string
  settings: {
    mounts: Record<string, ResourceConfig>
    mode: MountMode
    profiles?: Record<string, unknown>
    runtimes?: string[]
  }
  steps: Step[]
}

type Step = (
  | ({ op: 'mount'; path: string; mode?: MountMode } & ResourceConfig)
  | { op: 'unmount' | 'read' | 'readdir' | 'stat' | 'cached'; path: string }
  | { op: 'write'; path: string; data: string }
  | { op: 'exec'; command: string; session?: string }
  | { op: 'set_mode'; path: string; mode: MountMode }
  | { op: 'session'; id: string; profile?: Record<string, unknown> }
  | { op: 'set_profile'; session?: string; profile: Record<string, unknown> | string | null }
  | {
      op: 'register_cli'
      name: string
      script: ScriptDocument
      runtime?: string
      config?: Record<string, unknown>
    }
  | { op: 'unregister_cli' | 'add_runtime'; name: string }
  | { op: 'register_policy'; id: string; commands?: string[]; paths?: string[]; reason: string }
  | { op: 'unregister_policy'; id: string }
  | { op: 'mounts' | 'clis' | 'close' }
) & { expect?: Record<string, unknown>; session?: string }

interface ScriptDocument {
  source: string
  language: 'python' | 'js'
}

function profileDocument(raw: Record<string, unknown>) {
  const doc = { ...raw }
  if (doc.policy != null) {
    const policy = doc.policy as { script: ScriptDocument; runtime: string }
    doc.policy = {
      ...policy,
      script: new ScriptSource(policy.script.source, policy.script.language),
    }
  }
  return parseSessionProfile(doc)
}

interface Host {
  name: string
  workspace: new (resources: Record<string, Resource>, options: WorkspaceOptions) => Workspace
  build: (name: string, config: Record<string, unknown>) => Promise<Resource>
}

const HOSTS: Host[] = [
  { name: 'node', workspace: NodeWorkspace, build: buildNodeResource },
  { name: 'browser', workspace: BrowserWorkspace, build: buildBrowserResource },
]
const ENC = new TextEncoder()
const DEC = new TextDecoder()

class CachedRAMResource extends RAMResource {
  override readonly cachesReads = true
}

// Register a fixture through the same factory extension point as an embedder.
for (const register of [registerNodeResource, registerBrowserResource]) {
  register('cached-ram', (config) => {
    const resource = new CachedRAMResource()
    const files = (config.files ?? {}) as Record<string, string>
    resource.loadState({
      type: 'ram',
      files: Object.fromEntries(
        Object.entries(files).map(([path, data]) => [path, ENC.encode(data)]),
      ),
    })
    return Promise.resolve(resource)
  })
}

async function action(
  host: Host,
  ws: Workspace,
  step: Step,
  policies: Map<string, Policy>,
): Promise<unknown> {
  if (['read', 'write', 'readdir', 'stat'].includes(step.op) && step.session !== undefined) {
    const { session, ...unbound } = step
    return runWithSession(ws.getSession(session), () => action(host, ws, unbound, policies))
  }
  switch (step.op) {
    case 'cached': {
      const value = await ws.cache.get(step.path)
      return value === null ? null : DEC.decode(value)
    }
    case 'mount': {
      const resource = await host.build(step.resource, step.config ?? {})
      try {
        return ws.addMount(step.path, resource, step.mode ?? MountMode.READ).prefix
      } catch (err) {
        await resource.close()
        throw err
      }
    }
    case 'unmount':
      await ws.unmount(step.path)
      break
    case 'set_mode':
      ws.setMountMode(step.path, step.mode)
      break
    case 'session':
      ws.createSession(step.id, { profile: profileDocument(step.profile ?? {}) })
      break
    case 'set_profile':
      await ws.setSessionProfile(
        step.session ?? ws.defaultSessionId,
        typeof step.profile === 'object' && step.profile !== null
          ? profileDocument(step.profile)
          : step.profile,
      )
      break
    case 'register_cli':
      ws.registerCli(
        step.name,
        new CLISpec({
          name: step.name,
          script: new ScriptSource(step.script.source, step.script.language),
          ...(step.runtime !== undefined ? { runtime: step.runtime } : {}),
        }),
        step.config ?? null,
      )
      break
    case 'unregister_cli':
      ws.unregisterCli(step.name)
      break
    case 'clis':
      return [...ws.clis().keys()].sort()
    case 'add_runtime':
      return ws.addRuntime(step.name).name
    case 'register_policy': {
      if (policies.has(step.id)) throw new Error('policy already registered')
      const policy: Policy = {
        preCommand: (ctx) =>
          step.commands?.includes(ctx.command) ? { kind: 'deny', reason: step.reason } : null,
        preOps: (ctx) =>
          step.paths?.includes(ctx.path.virtual) ? { kind: 'deny', reason: step.reason } : null,
      }
      ws.policies.add(policy)
      policies.set(step.id, policy)
      break
    }
    case 'unregister_policy': {
      const policy = policies.get(step.id)
      if (policy === undefined) return false
      policies.delete(step.id)
      return ws.policies.remove(policy)
    }
    case 'write':
      await ws.fs.writeFile(step.path, ENC.encode(step.data))
      break
    case 'read':
      return DEC.decode(await ws.fs.readFile(step.path))
    case 'readdir':
      return (await ws.fs.readdir(step.path)).sort()
    case 'stat': {
      const row = await ws.fs.stat(step.path)
      return { type: row.type, size: row.size }
    }
    case 'exec': {
      const result = await ws.execute(
        step.command,
        step.session === undefined ? {} : { sessionId: step.session },
      )
      return {
        exit_code: result.exitCode,
        stdout: result.stdoutText,
        stderr: result.stderrText,
        refusal: result.refusal?.reason ?? null,
      }
    }
    case 'mounts':
      return ws
        .mounts()
        .map((m) => m.prefix)
        .sort()
    case 'close':
      await ws.close()
      break
    default:
      throw new Error(`unknown lifecycle action: ${String((step as { op: string }).op)}`)
  }
  return null
}

async function run(host: Host, testCase: Case): Promise<number> {
  const resources: Record<string, Resource> = {}
  for (const [prefix, config] of Object.entries(testCase.settings.mounts)) {
    resources[prefix] = await host.build(config.resource, config.config ?? {})
  }
  const profiles = Object.fromEntries(
    Object.entries(testCase.settings.profiles ?? {}).map(([name, profile]) => [
      name,
      parseSessionProfile(profile),
    ]),
  )
  const ws = new host.workspace(resources, {
    mode: testCase.settings.mode,
    profiles,
    ...(testCase.settings.runtimes !== undefined ? { runtimes: testCase.settings.runtimes } : {}),
  })
  const policies = new Map<string, Policy>()
  try {
    for (const [index, step] of testCase.steps.entries()) {
      let actual: Record<string, unknown>
      try {
        actual = { value: await action(host, ws, step, policies) }
      } catch (err) {
        actual = { error: err instanceof Error ? err.message : String(err) }
        const condition = classify(err)
        if (condition !== null) actual.errno = condition
      }
      const expected = step.expect ?? { value: null }
      if (!matches(actual, expected)) {
        throw new Error(
          `step ${index + 1} (${step.op}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        )
      }
    }
    return testCase.steps.length
  } finally {
    await ws.close()
  }
}

function matches(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
    return isDeepStrictEqual(actual, expected)
  }
  if (actual === null || typeof actual !== 'object') return false
  const fields = actual as Record<string, unknown>
  return Object.entries(expected).every(([key, want]) => {
    const field = key.replace(/_contains$/, '')
    if (!(field in fields)) return false
    const got = fields[field]
    return key === 'error' || key.endsWith('_contains')
      ? typeof got === 'string' && typeof want === 'string' && got.includes(want)
      : matches(got, want)
  })
}

const suite = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8')) as {
  cases: Case[]
}
let passed = 0
let steps = 0
let failures = 0
for (const host of HOSTS) {
  for (const testCase of suite.cases) {
    try {
      steps += await run(host, testCase)
      passed++
      console.log(`ok ${host.name}/${testCase.id}`)
    } catch (err) {
      failures++
      console.error(`FAIL ${host.name}/${testCase.id}: ${String(err)}`)
    }
  }
}
console.log(`${passed} cases / ${steps} steps passed, ${failures} failed`)
process.exitCode = failures > 0 ? 1 : 0
