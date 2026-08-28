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

import { writeFileSync } from 'node:fs'
import { ConsistencyPolicy } from '@struktoai/mirage-node'
import { parseSessionProfile } from '@struktoai/mirage-core/policy/profile'
import { ADAPTERS, openConsistency } from './adapters.ts'
import type { Case, Target } from './harness.ts'
import {
  Report,
  compare,
  integRoot,
  loadCases,
  loadServices,
  loadTargets,
  missingEnv,
  parseAllowSkip,
  bindMount,
  ruleReasons,
  runCase,
  runScenario,
  seedFixture,
  seedMountRoot,
} from './harness.ts'

const TS_HOSTS = ['typescript-node', 'typescript-browser']

interface EmitRow {
  target: string
  id: string
  exit: number
  stdout: string
  stderr: string
  check: string | null
}

function parseArgs(): {
  targets: string[]
  emit: string | undefined
  facet: string | undefined
  strict: boolean
  allowSkip: string
  targetJobs: number
  profile: boolean
} {
  const targets: string[] = []
  let emit: string | undefined
  let facet: string | undefined
  let strict = false
  let allowSkip = ''
  let targetJobs = 1
  let profile = false
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && i + 1 < argv.length) targets.push(argv[++i])
    else if (argv[i] === '--facet' && i + 1 < argv.length) facet = argv[++i]
    else if (argv[i] === '--emit' && i + 1 < argv.length) emit = argv[++i]
    else if (argv[i] === '--strict') strict = true
    else if (argv[i] === '--allow-skip' && i + 1 < argv.length) allowSkip = argv[++i]
    else if (argv[i] === '--profile') profile = true
    else if (argv[i] === '--target-jobs' && i + 1 < argv.length) {
      const n = Number(argv[++i])
      if (!Number.isInteger(n) || n < 1) {
        process.stderr.write('--target-jobs takes an integer >= 1\n')
        process.exit(2)
      }
      targetJobs = n
    }
  }
  return { targets, emit, facet, strict, allowSkip, targetJobs, profile }
}

async function runTarget(
  target: Target,
  cases: Case[],
  root: string,
  report: Report | null,
  emit: EmitRow[] | null,
): Promise<void> {
  // A console block is only wired into the ram opener; refusing it
  // anywhere else keeps a silently RAM-consoled "redis console" target
  // from reading as covered.
  if (target.console !== undefined && target.mounts[0].resource !== 'ram') {
    throw new Error(`target ${target.id}: console targets ride ram mounts`)
  }
  // Profiles reach the workspace only through the openers that pass them
  // on, for the same reason: a target that declares one on an opener
  // that drops it would run unbound and read as covered. Python needs no
  // such list because it builds every target's workspace in one place.
  const PROFILE_OPENERS = ['ram', 'disk', 'email']
  const declaresProfiles = target.profiles !== undefined || target.profile !== undefined
  if (declaresProfiles && !PROFILE_OPENERS.includes(target.mounts[0].resource)) {
    throw new Error(`target ${target.id}: profiles ride ${PROFILE_OPENERS.join(', ')} mounts`)
  }
  const { ws, cleanup } = await ADAPTERS[target.mounts[0].resource](target)
  try {
    // A target's declared environment. A CLI whose spec reads a variable
    // (ntn's --notion-version off NOTION_API_VERSION) behaves differently with
    // and without it, so the conformance runner passes the same map to the real
    // binary and the comparison stays like for like.
    // Through the setter, not into the record: `ws.env` is a frozen
    // projection of the variable records, and a target's declared
    // environment is exported by definition -- a CLI reads it as a
    // process environment, which carries exported names only.
    ws.env = { ...ws.env, ...(target.env ?? {}) }
    for (const mount of target.mounts) {
      await seedFixture(ws, mount.fixture, mount.path, root)
      if (mount.seed_root) await seedMountRoot(ws, mount.path)
    }
    // Sessions a case can name via its `session` field, through the two
    // doors a host really has. A string names one of the target's profiles
    // (`profile`), which is the whole document that session runs under.
    // A mapping is an inline document added to the default profile
    // (`permissions`): it may add ask and deny rules and hides, never an
    // allow list, so a session that needs its own allow list has to be a
    // profile. An empty mapping is the default profile with nothing added.
    // A profile written by a script is ready only after hydration, which
    // every embedding program already awaits before it creates a
    // session; the battery is a program like any other.
    await ws.ensureSessionsLoaded()
    for (const [sessionId, spec] of Object.entries(target.sessions ?? {})) {
      if (typeof spec === 'string') {
        ws.createSession(sessionId, { profile: spec })
      } else if (spec !== null && Object.keys(spec).length > 0) {
        ws.createSession(sessionId, {
          permissions: parseSessionProfile(spec, `session ${sessionId}`),
        })
      } else {
        ws.createSession(sessionId, {})
      }
    }
    // Only a target carrying a permissions document has a verdict for
    // `explain` to predict, and only there is the extra dry run per case
    // worth its time. The reasons double as the tell that a refusal came
    // from the policy layer rather than from the command itself.
    const reasons = ruleReasons({ profiles: target.profiles, sessions: target.sessions })
    for (const c of cases) {
      if (!c.targets.includes(target.id)) continue
      if (c.consistency !== undefined) continue
      const bound = bindMount(c, target.mounts[0].path)
      const { exitCode, out, err, elapsed, checkOut, notes } = await runCase(ws, bound, reasons)
      if (emit !== null) {
        emit.push({
          target: target.id,
          id: bound.id,
          exit: exitCode,
          stdout: out,
          stderr: err,
          check: checkOut,
        })
      } else if (report !== null) {
        report.record(
          target.id,
          bound.id,
          compare(bound, exitCode, out, err, elapsed, checkOut, notes),
          elapsed,
          bound.command,
        )
      }
    }
  } finally {
    await cleanup()
  }
  const scenarios = cases.filter(
    (c) => c.targets.includes(target.id) && c.consistency !== undefined && c.scenario !== undefined,
  )
  for (const c of scenarios) {
    const policy = c.consistency === 'always' ? ConsistencyPolicy.ALWAYS : ConsistencyPolicy.LAZY
    const opened = await openConsistency(target, policy)
    if (opened === null) {
      // Loud on purpose: an adapter that cannot build a shadow workspace used
      // to drop every scenario case for its target without a word.
      process.stderr.write(
        `skip [${target.id}] ${c.id}: ${target.mounts[0].resource} adapter has no shadow workspace\n`,
      )
      continue
    }
    try {
      // Same rule as the ordinary path: a target's declared environment reaches
      // every workspace a case can run against, or a consistency scenario would
      // silently run under a different one.
      opened.ws.env = { ...opened.ws.env, ...(target.env ?? {}) }
      const started = performance.now()
      const { exitCode, out } = await runScenario(opened.ws, opened.mutate, c.scenario)
      // Measured, not zero: a consistency scenario on s3 or gridfs runs
      // several remote mutations, and recording it as free dragged the
      // profile's totals and percentiles down.
      const elapsed = (performance.now() - started) / 1000
      if (emit !== null) {
        emit.push({ target: target.id, id: c.id, exit: exitCode, stdout: out, stderr: '' })
      } else if (report !== null) {
        report.record(target.id, c.id, compare(c, exitCode, out, '', elapsed), elapsed, c.command)
      }
    } finally {
      await opened.cleanup()
    }
  }
}

async function main(): Promise<void> {
  const root = integRoot()
  const manifest = loadTargets(root)
  const services = loadServices(root)
  const cases = loadCases(root)

  const { targets, emit: emitPath, facet, strict, allowSkip, targetJobs, profile } = parseArgs()
  // Targets are grouped into facets so CI can run one backend family per job; a
  // target with no facet belongs to "core", which the shared battery runs.
  let ids: string[]
  if (facet !== undefined) {
    ids = [...manifest.entries()].filter(([, t]) => (t.facet ?? 'core') === facet).map(([id]) => id)
    if (ids.length === 0) {
      process.stderr.write(`no targets in facet '${facet}'\n`)
      process.exit(2)
    }
  } else {
    ids = targets.length ? targets : [...manifest.keys()]
  }
  const report = emitPath ? null : new Report()
  const emit: EmitRow[] | null = emitPath ? [] : null
  let ran = 0
  // A facet can be split across CI jobs (core's databases and vector stores
  // run in integ-database/integ-data), so a job names the services it
  // knowingly does not provision. Anything skipping outside this list is a
  // broken job, which is the whole point of --strict.
  const allowed = parseAllowSkip(services, allowSkip)
  const envSkipped: string[] = []
  const eligible: Target[] = []
  for (const id of ids) {
    const target = manifest.get(id)
    if (!target) throw new Error(`unknown target: ${id}`)
    if (!target.hosts.some((h) => TS_HOSTS.includes(h))) {
      process.stderr.write(`skip [${id}]: not a typescript host\n`)
      continue
    }
    if (!(target.mounts[0].resource in ADAPTERS)) {
      process.stderr.write(`skip [${id}]: no typescript adapter\n`)
      continue
    }
    const missing = missingEnv(services, target, 'typescript')
    if (missing.length) {
      process.stderr.write(`skip [${id}]: ${missing.join(', ')} not set\n`)
      if (target.service === undefined || !allowed.has(target.service)) {
        envSkipped.push(`${id} (${missing.join(', ')})`)
      }
      continue
    }
    eligible.push(target)
    ran += 1
  }

  // Targets own separate workspaces, so they overlap safely -- except when two
  // speak to the SAME fake (cli-gh and github, cli-ntn and notion, qdrant and
  // qdrant-window). Those share a lane and stay sequential; the rest are bound
  // only by the overall width.
  // One worker means the old loop, unchanged. The lane scheduler below cannot
  // stand in for it: a target waiting on a busy lane lets a later one from
  // another lane take the worker first, and with `s3` carrying three targets
  // and `gws` four, the default run would quietly reorder itself.
  if (targetJobs <= 1) {
    for (const target of eligible) {
      await runTarget(target, cases, root, report, emit)
    }
  } else {
    const lanes = new Map<string, Promise<void>>()
    const errors: unknown[] = []
    const waiters: (() => void)[] = []
    let active = 0
    const acquire = async (): Promise<void> => {
      if (active >= targetJobs) await new Promise<void>((resolve) => waiters.push(resolve))
      active += 1
    }
    const release = (): void => {
      active -= 1
      const next = waiters.shift()
      if (next !== undefined) next()
    }
    const slots = new Map<string, { report: Report | null; emit: EmitRow[] | null }>()
    const chain: Promise<void>[] = []
    for (const target of eligible) {
      const slot = {
        report: report === null ? null : new Report(false),
        emit: emit === null ? null : ([] as EmitRow[]),
      }
      slots.set(target.id, slot)
      const lane = target.service ?? `solo:${target.id}`
      const prev = lanes.get(lane) ?? Promise.resolve()
      const next = prev.then(async () => {
        await acquire()
        try {
          await runTarget(target, cases, root, slot.report, slot.emit)
        } catch (err) {
          errors.push(err)
        } finally {
          release()
        }
      })
      lanes.set(lane, next)
      chain.push(next)
    }
    await Promise.all(chain)
    // Merged in declared target order, so a concurrent run prints what a serial
    // run printed.
    for (const target of eligible) {
      const slot = slots.get(target.id)
      if (slot === undefined) continue
      if (report !== null && slot.report !== null) report.absorb(slot.report)
      if (emit !== null && slot.emit !== null) emit.push(...slot.emit)
    }
    if (errors.length > 0) throw errors[0]
  }

  // A skip is one line on stderr and exit 0, so a facet whose service
  // never came up (or whose env var got renamed in the workflow) reports
  // green having tested nothing. Every facet has targets on both hosts,
  // so zero of them running is always a broken job, never a valid run.
  if (facet !== undefined && ran === 0) {
    process.stderr.write(`facet '${facet}' ran no targets\n`)
    process.exit(2)
  }

  // The facet guard above only fires when *every* target skipped, so a
  // two-target facet that loses one still reports green. CI passes --strict,
  // which starts every service its facet declares, so there a missing
  // variable is a broken job rather than a local convenience.
  if (strict && envSkipped.length) {
    process.stderr.write(
      `strict: ${String(envSkipped.length)} target(s) skipped for missing env: ` +
        `${envSkipped.join('; ')}\n`,
    )
    process.exit(2)
  }
  if (emitPath) {
    writeFileSync(emitPath, JSON.stringify(emit))
    return
  }
  if (report === null) return
  if (profile) process.stdout.write(`${report.profile()}\n`)
  process.stdout.write(`\n${report.summary()}\n`)
  if (report.failed) process.exit(1)
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + '\n')
  process.exit(1)
})
