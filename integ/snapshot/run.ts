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

// The TypeScript arm of the cross-language snapshot battery, the twin
// of run.py: `write` builds a world, records what it observes and
// leaves a tar; `read` builds the same world fresh, loads the other
// arm's tar into it, and records the same observations. cross.sh diffs
// the two records.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ADAPTERS } from '../runners/typescript/adapters/index.ts'
import {
  integRoot,
  loadServices,
  missingEnv,
  seedFixture,
  type ExecWorkspace,
  type Target,
} from '../runners/typescript/harness.ts'
import { Outcome, Scope } from '@struktoai/mirage-core/policy/types'
import type { Policy } from '@struktoai/mirage-core/policy/index'
import { parseSessionProfile, type SessionProfile } from '@struktoai/mirage-core/policy/profile'
import { CLISpec } from '@struktoai/mirage-core/commands/cli/types'
import { ScriptSource } from '@struktoai/mirage-core/runtime/routing/types'
import { DriftPolicy } from '@struktoai/mirage-core/types'
import { Workspace } from '@struktoai/mirage-node'
import { readSnapshotTar } from '@struktoai/mirage-core/workspace/snapshot/tar_io'
import type { WorkspaceStateDict } from '@struktoai/mirage-core/workspace/snapshot/types'

const HOST = 'typescript'
const RUNTIME = 'pyodide'
const SUITE = new URL('./cases.json', import.meta.url)

interface ScriptDoc {
  source: string
  language: 'python' | 'js'
  runtime: string
}

interface PolicyRule {
  id: string
  commands?: string[]
  paths?: string[]
  vars?: string[]
  reason: string
}

interface Step {
  op: string
  command?: string
  session?: string
  path?: string
  data?: string
  mode?: string
  literals?: string[]
  expect?: Record<string, unknown>
}

interface Case {
  id: string
  target: Target
  script?: Record<string, ScriptDoc>
  script_cli?: { name: string } & Record<string, unknown>
  policies?: PolicyRule[]
  seed?: Step[]
  verify: Step[]
  load?: { profiles?: boolean; runtimes?: boolean; policies?: boolean; drift?: string }
}

/**
 * A coded policy the case declares and the loader re-registers.
 *
 * A snapshot names a policy class and cannot carry it, so both arms
 * register one of the same name and the battery compares what the
 * restored workspace reports. A class, not an object literal: the
 * recorded name is `constructor.name`, and a literal's is `Object`.
 */
class RulePolicy implements Policy {
  constructor(private readonly rule: PolicyRule) {}

  preCommand(ctx: { command: string }) {
    return (this.rule.commands ?? []).includes(ctx.command)
      ? { kind: 'deny' as const, reason: this.rule.reason }
      : null
  }

  preOps(ctx: { path: { virtual: string } }) {
    return (this.rule.paths ?? []).includes(ctx.path.virtual)
      ? { kind: 'deny' as const, reason: this.rule.reason }
      : null
  }

  preSession(ctx: { key: string }) {
    return (this.rule.vars ?? []).includes(ctx.key)
      ? { kind: 'deny' as const, reason: this.rule.reason }
      : null
  }
}

/** This host's half of a two-language script declaration. */
function hostScript(testCase: Case, key: 'script' | 'script_cli'): ScriptDoc {
  const table = testCase[key] as Record<string, ScriptDoc> | undefined
  if (table === undefined) throw new Error(`case ${testCase.id} declares no ${key}`)
  const doc = table[HOST]
  if (doc === undefined) throw new Error(`case ${testCase.id} has no ${key} for ${HOST}`)
  return doc
}

/**
 * The target this host opens, with its script placeholder filled.
 *
 * A policy program is written once per language and names the runtime
 * that language has: python's default world carries monty and this
 * one carries pyodide, so the document a snapshot carries names a
 * runtime the other arm does not have. That is what the loader's
 * `profiles` and `runtimes` are for.
 */
function targetOf(testCase: Case): Target {
  const target = JSON.parse(JSON.stringify(testCase.target)) as Target
  const profiles = target.profiles
  if (profiles !== undefined) {
    for (const [name, doc] of Object.entries(profiles)) {
      if (doc !== '@script') continue
      const script = hostScript(testCase, 'script')
      profiles[name] = {
        commands: { allow: ['echo', 'cat', 'ls', 'rm', 'touch', 'mkdir'] },
        policy: {
          script: { source: script.source, language: script.language },
          runtime: script.runtime,
        },
      }
    }
  }
  return target
}

/** The documents a reader states for itself, or undefined to use the tar's. */
function profileDocuments(testCase: Case): Record<string, SessionProfile> | undefined {
  if (testCase.load?.profiles !== true) return undefined
  const out: Record<string, SessionProfile> = {}
  for (const [name, doc] of Object.entries(targetOf(testCase).profiles ?? {})) {
    const raw = doc as { policy?: { script: { source: string; language: 'python' | 'js' } } }
    const revived =
      raw.policy === undefined
        ? doc
        : {
            ...(doc as object),
            policy: {
              ...raw.policy,
              script: new ScriptSource(raw.policy.script.source, raw.policy.script.language),
            },
          }
    out[name] = parseSessionProfile(revived, `profile \`${name}\``)
  }
  return out
}

/** The case's own program as a spec in this host's language. */
function scriptCliSpec(testCase: Case): CLISpec | null {
  if (testCase.script_cli === undefined) return null
  const script = hostScript(testCase, 'script_cli')
  return new CLISpec({
    name: testCase.script_cli.name,
    script: new ScriptSource(script.source, script.language),
    runtime: script.runtime,
  })
}

/**
 * Open this case's world and add what a target cannot declare.
 *
 * The adapter states most of the target document -- mounts, named
 * profiles, the default profile, account CLIs. The env block, the
 * target's own sessions and the case's own program are added here,
 * which is what the shared runner does too.
 *
 * No runtime is added: python's default world carries monty and this
 * one carries pyodide, so each arm's script already names a runtime it
 * has. What the reading arm proves instead is the loader's own
 * `runtimes` knob, since a snapshot carries none.
 */
async function build(
  testCase: Case,
  sessions: boolean,
): Promise<{ ws: Workspace; cleanup: () => Promise<void> }> {
  const target = targetOf(testCase)
  const opener = ADAPTERS[target.mounts[0].resource]
  if (opener === undefined) {
    throw new Error(`no adapter for resource ${target.mounts[0].resource}`)
  }
  const opened = await opener(target)
  const ws = opened.ws as unknown as Workspace
  if (target.env !== undefined) ws.env = { ...ws.env, ...target.env }
  const spec = scriptCliSpec(testCase)
  if (spec !== null) ws.registerCli(spec.name, spec, null)
  await ws.ensureSessionsLoaded()
  if (sessions) {
    for (const [sid, spec2] of Object.entries(target.sessions ?? {})) {
      if (typeof spec2 === 'string') {
        ws.createSession(sid, { profile: spec2 })
      } else {
        const doc = parseSessionProfile(spec2 ?? {}, `session \`${sid}\``)
        ws.createSession(sid, { permissions: doc })
      }
    }
  }
  return { ws, cleanup: opened.cleanup }
}

/** Anything a state dict holds, as text an `absent` scan can read. */
function readable(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('latin1')
  if (value instanceof Map) return Object.fromEntries(value)
  return value
}

/**
 * The literals a manifest must not spell, and whether it does.
 *
 * The check is on the serialized state rather than on any one config
 * field: an alias resource records its own config under its parent's
 * type, which is how a redaction check keyed on a class's field names
 * missed one. Bytes are decoded rather than skipped, so a credential a
 * resource wrote into its own content cannot walk past.
 */
function absent(wanted: string[], manifest: WorkspaceStateDict | null): string[] {
  if (manifest === null) return []
  const text = JSON.stringify(manifest, readable)
  const found: string[] = []
  for (const raw of wanted) {
    const needle =
      raw.startsWith('${') && raw.endsWith('}') ? (process.env[raw.slice(2, -1)] ?? '') : raw
    if (needle !== '' && text.includes(needle)) found.push(raw)
  }
  return found
}

/** Fail a step whose own expectation the observation misses. */
function check(step: Step, got: Record<string, unknown>): void {
  for (const [key, want] of Object.entries(step.expect ?? {})) {
    const field = key.endsWith('_contains') ? key.slice(0, -'_contains'.length) : key
    const actual = got[field]
    if (key.endsWith('_contains')) {
      if (typeof actual !== 'string' || !actual.includes(String(want))) {
        throw new Error(
          `${String(step.command)}: ${field} does not contain ${JSON.stringify(want)}: ${JSON.stringify(actual)}`,
        )
      }
    } else if (actual !== want) {
      throw new Error(
        `${String(step.command)}: ${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(want)}`,
      )
    }
  }
}

/** One verify step's observation, checked against its own expect. */
async function one(
  ws: Workspace,
  step: Step,
  manifest: WorkspaceStateDict | null,
): Promise<unknown> {
  const exec = ws as unknown as ExecWorkspace
  switch (step.op) {
    case 'exec': {
      const result = await ws.execute(
        String(step.command),
        step.session === undefined ? {} : { sessionId: step.session },
      )
      const got = {
        exit: result.exitCode,
        stdout: result.stdoutText,
        stderr: result.stderrText,
        refusal: result.refusal?.reason ?? null,
      }
      check(step, got)
      return got
    }
    case 'write':
      await ws.fs.writeFile(String(step.path), new TextEncoder().encode(String(step.data)))
      return null
    case 'read':
      return new TextDecoder().decode(await ws.fs.readFile(String(step.path)))
    case 'readdir':
      return (await ws.fs.readdir(String(step.path))).sort()
    case 'answer': {
      for (const record of exec.decisions.pending()) {
        if (step.mode === 'deny') {
          await exec.decisions.answer(record.id, Outcome.DENY)
        } else {
          await exec.decisions.answer(
            record.id,
            Outcome.ALLOW,
            step.mode === 'allow_session' ? Scope.SESSION : Scope.ONCE,
          )
        }
      }
      return null
    }
    case 'sessions':
      // The default session's id is minted per workspace and travels in
      // the snapshot, so it is named rather than spelled.
      return ws
        .listSessions()
        .map((s) => (s.sessionId === ws.defaultSessionId ? '<default>' : s.sessionId))
        .sort()
    case 'profile_of':
      return ws.getSession(String(step.session)).profile
    case 'hides': {
      const session = ws.getSession(String(step.session))
      const hidden = session.hiddenPaths
      return {
        paths: [...(hidden?.paths ?? [])].sort(),
        patterns: [...(hidden?.patterns ?? [])].sort(),
        shown: (session.shownPaths?.entries ?? []).map((e) => e.path).sort(),
        vars: [...(session.hiddenVars?.names ?? [])].sort(),
      }
    }
    case 'decisions':
      return ws.decisions.list(String(step.session)).map((d) => ({
        outcome: d.outcome ?? null,
        scope: d.scope ?? null,
        reason: d.rule.reason,
      }))
    case 'clis':
      return [...ws.clis().keys()].sort()
    case 'mounts':
      return ws
        .mounts()
        .map((m) => m.prefix)
        .sort()
    case 'policies':
      return [...ws.policies.names()].sort()
    case 'runtimes':
      return ws.runtimeEntries.map((r) => r.name)
    case 'env':
      return Object.fromEntries(Object.entries(ws.env).sort(([a], [b]) => a.localeCompare(b)))
    case 'live_only':
      return [...(manifest?.live_only_mounts ?? [])].sort()
    case 'fingerprints':
      return [...new Set((manifest?.fingerprints ?? []).map((r) => String(r.path)))].sort()
    case 'absent':
      return absent(step.literals ?? [], manifest)
    default:
      throw new Error(`unknown snapshot verify op: ${step.op}`)
  }
}

/** Run the verify steps and answer what each one saw. */
async function observe(
  ws: Workspace,
  steps: Step[],
  manifest: WorkspaceStateDict | null,
): Promise<unknown[]> {
  const seen: unknown[] = []
  for (const step of steps) seen.push(await one(ws, step, manifest))
  return seen
}

/** The state a tar carries, as the loader reads it. */
async function manifestOf(tar: string): Promise<WorkspaceStateDict> {
  return (await readSnapshotTar(new Uint8Array(readFileSync(tar)))) as WorkspaceStateDict
}

function record(dir: string, id: string, seen: unknown[]): void {
  writeFileSync(join(dir, `${id}.${HOST}.json`), `${JSON.stringify(seen, sortKeys, 2)}\n`)
}

/** Stable key order, so the two arms' records compare as text. */
function sortKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
  )
}

function gaps(testCase: Case, root: string): string[] {
  return missingEnv(loadServices(root), testCase.target, 'typescript')
}

async function writeOne(testCase: Case, out: string, root: string): Promise<void> {
  const { ws, cleanup } = await build(testCase, true)
  const tar = join(out, `${testCase.id}.tar`)
  let seen: unknown[]
  try {
    for (const mount of testCase.target.mounts) {
      await seedFixture(ws as unknown as ExecWorkspace, mount.fixture, mount.path, root)
    }
    await observe(ws, testCase.seed ?? [], null)
    // After the seed: a coded policy that refuses a path would
    // otherwise refuse the write that puts the path there.
    for (const rule of testCase.policies ?? []) ws.policies.add(new RulePolicy(rule))
    await ws.snapshot(tar)
    seen = await observe(ws, testCase.verify, await manifestOf(tar))
  } finally {
    await cleanup()
  }
  record(out, testCase.id, seen)
}

async function readOne(testCase: Case, tar: string, out: string, root: string): Promise<void> {
  const host = await build(testCase, false)
  let seen: unknown[]
  try {
    for (const mount of testCase.target.mounts) {
      await seedFixture(host.ws as unknown as ExecWorkspace, mount.fixture, mount.path, root)
    }
    const overrides: Record<string, never> = {}
    for (const mount of host.ws.mounts()) {
      ;(overrides as Record<string, unknown>)[mount.prefix] = mount.resource
    }
    // An account CLI's config is redacted in the tar, so the loader is
    // handed the live one this world just built. A script CLI needs its
    // whole spec swapped instead: the tar carries the writing host's
    // program, which names a runtime this host does not have, and a
    // [spec, config] override is the door for it.
    const clis: Record<string, unknown> = {}
    for (const [name, install] of host.ws.clis()) {
      if (install.config != null) clis[name] = install.config
    }
    const swap = scriptCliSpec(testCase)
    if (swap !== null) clis[swap.name] = [swap, null]
    const load = testCase.load ?? {}
    const ws = await Workspace.load(
      tar,
      {
        driftPolicy: load.drift === 'off' ? DriftPolicy.OFF : DriftPolicy.STRICT,
        ...(profileDocuments(testCase) !== undefined
          ? { profiles: profileDocuments(testCase) }
          : {}),
        ...(load.runtimes === true ? { runtimes: [RUNTIME] } : {}),
        ...(load.policies === true
          ? { policies: (testCase.policies ?? []).map((r) => new RulePolicy(r)) }
          : {}),
      },
      overrides,
      clis as never,
    )
    try {
      await ws.ensureSessionsLoaded()
      seen = await observe(ws, testCase.verify, await manifestOf(tar))
    } finally {
      await ws.close()
    }
  } finally {
    await host.cleanup()
  }
  record(out, testCase.id, seen)
}

async function main(): Promise<number> {
  const [mode, , dir, ...rest] = process.argv.slice(2)
  if (mode !== 'write' && mode !== 'read') {
    console.error('usage: run.ts <write|read> <run> <dir> [--out DIR] [--case ID]')
    return 2
  }
  const outFlag = rest.indexOf('--out')
  const caseFlag = rest.indexOf('--case')
  const out = outFlag === -1 ? dir : rest[outFlag + 1]
  const only = caseFlag === -1 ? null : rest[caseFlag + 1]
  const root = integRoot()
  const suite = JSON.parse(readFileSync(SUITE, 'utf8')) as { cases: Case[] }
  mkdirSync(out, { recursive: true })
  let failures = 0
  for (const testCase of suite.cases) {
    if (only !== null && testCase.id !== only) continue
    const needs = gaps(testCase, root)
    if (needs.length > 0) {
      console.log(`skip ${HOST}/${mode}/${testCase.id}: needs ${needs.join(', ')}`)
      if (mode === 'write') writeFileSync(join(out, `${testCase.id}.skip`), needs.join(','))
      continue
    }
    const tar = join(dir, `${testCase.id}.tar`)
    if (mode === 'read' && !existsSync(tar)) {
      console.log(`skip ${HOST}/read/${testCase.id}: the writing arm left no tar`)
      continue
    }
    try {
      if (mode === 'write') await writeOne(testCase, out, root)
      else await readOne(testCase, tar, out, root)
      console.log(`ok ${HOST}/${mode}/${testCase.id}`)
    } catch (err) {
      failures++
      console.error(`FAIL ${HOST}/${mode}/${testCase.id}: ${String(err)}`)
      if (process.env.SNAP_TRACE !== undefined && err instanceof Error) console.error(err.stack)
    }
  }
  return failures > 0 ? 1 : 0
}

process.exitCode = await main()
