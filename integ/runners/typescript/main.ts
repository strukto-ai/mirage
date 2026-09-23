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
import { type ReadSpec } from '@struktoai/mirage-node'
import { resolveReadSpec } from '@struktoai/mirage-core/workspace/mount/read_policy'
import { parseSessionProfile } from '@struktoai/mirage-core/policy/profile'
import { ConcurrencyLimiter } from '@struktoai/mirage-core/concurrency/limiter'
import { ADAPTERS, openConsistency } from './adapters/index.ts'
import type { Case, EmitRow, ServiceEnv, Target, TargetRunner } from './harness.ts'
import {
  Report,
  compare,
  planRun,
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

/**
 * How many targets may be in flight, refusing what `int()` would refuse.
 *
 * `Number()` is wider than python's `int()` -- it takes `0x10`, `1e2` and
 * `4.0` and would have run 16, 100 and 4 workers where argparse exits 2 --
 * so the digits are checked before the value is read.
 */
function parseJobs(raw: string): number {
  const n = Number(raw)
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(n) || n < 1) {
    process.stderr.write('--target-jobs takes an integer >= 1\n')
    process.exit(2)
  }
  return n
}

function parseArgs(): {
  targets: string[]
  emit: string | undefined
  facet: string | undefined
  strict: boolean
  allowSkip: string
  targetJobs: number
} {
  const targets: string[] = []
  let emit: string | undefined
  let facet: string | undefined
  let strict = false
  let allowSkip = ''
  // How many targets may be in flight. One is the plain loop, which stays the
  // default so a local run is sequential and debuggable and so landing the
  // scheduler changes nothing until a workflow line asks for it.
  let targetJobs = 1
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && i + 1 < argv.length) targets.push(argv[++i])
    else if (argv[i] === '--facet' && i + 1 < argv.length) facet = argv[++i]
    else if (argv[i] === '--emit' && i + 1 < argv.length) emit = argv[++i]
    else if (argv[i] === '--strict') strict = true
    else if (argv[i] === '--allow-skip' && i + 1 < argv.length) allowSkip = argv[++i]
    else if (argv[i] === '--target-jobs' || argv[i].startsWith('--target-jobs=')) {
      // Both spellings, and a missing value refused rather than ignored,
      // because argparse takes `--target-jobs=4` and refuses the empty form
      // on the python host. A word this chain does not match is dropped in
      // silence, so either would have left the default of one worker and
      // exited 0 -- the concurrency a workflow asked for, silently gone.
      // The same hole is open on every other flag here and is left alone:
      // it predates this change.
      const eq = argv[i].indexOf('=')
      targetJobs = parseJobs(
        eq === -1 ? (i + 1 < argv.length ? argv[++i] : '') : argv[i].slice(eq + 1),
      )
    }
  }
  return { targets, emit, facet, strict, allowSkip, targetJobs }
}

/**
 * Run every eligible target with at most `width` in flight.
 *
 * Targets own separate workspaces and mint a fresh run id per open, so they
 * overlap safely; `planRun` names the two kinds that cannot. Output order does not
 * depend on completion order: every target, exclusive ones included, fills its
 * own report and emit slot, and the slots are absorbed in selection order. So
 * a concurrent run prints exactly what the serial run printed on STDOUT --
 * stderr is written straight through from inside `runTarget` and interleaves.
 *
 * Returns how many targets threw. Reported by the caller after the summary,
 * rather than exiting here, so a pooled run that lost one target still prints
 * the counts for every other one.
 */
export async function runPool(
  eligible: Target[],
  cases: Case[],
  root: string,
  report: Report | null,
  emit: EmitRow[] | null,
  services: Map<string, ServiceEnv>,
  width: number,
  runner: TargetRunner = runTarget,
): Promise<number> {
  const { alone, pool } = planRun(eligible, services)
  // On stderr, so the stdout equivalence holds, and unconditional so a change
  // that quietly routed every run down the serial loop would show as this line
  // going missing rather than as the battery merely being slower. Mutation
  // testing found that exact regression invisible.
  process.stderr.write(
    `pool: ${String(pool.length)} target(s) at width ${String(width)}, ${String(alone.length)} alone\n`,
  )
  const slots = eligible.map(() => ({
    report: report === null ? null : new Report(false),
    emit: emit === null ? null : ([] as EmitRow[]),
  }))
  const errors: [string, unknown][] = []
  for (const at of alone) {
    try {
      await runner(eligible[at], cases, root, slots[at].report, slots[at].emit)
    } catch (err: unknown) {
      errors.push([eligible[at].id, err])
    }
  }
  const limiter = new ConcurrencyLimiter(width)
  // A lane is a promise chain rather than a lock: node has no mutex, and
  // chaining gives the same "never two at once" without a queue of our own.
  const lanes = new Map<string, Promise<void>>()
  const running: (Promise<void> | null)[] = eligible.map(() => null)
  for (const { at, lane } of pool) {
    const target = eligible[at]
    const slot = slots[at]
    const prev = lanes.get(lane) ?? Promise.resolve()
    // The lane is taken before the worker so a target waiting on a busy lane
    // is not holding one of the four slots while it waits.
    const next = prev.then(async () => {
      const release = await limiter.acquire()
      try {
        await runner(target, cases, root, slot.report, slot.emit)
      } catch (err: unknown) {
        // Recorded, not thrown: a sibling still has a workspace open and a
        // backend to tear down, and rejecting here would strand both.
        errors.push([target.id, err])
      } finally {
        release()
      }
    })
    lanes.set(lane, next)
    running[at] = next
  }
  // Awaited in selection order, and each slot flushed the moment every slot
  // before it has. Waiting for the whole pool before printing anything would
  // give CI one silent step and then a wall of text, which is the failure
  // mode a buffered script already has here.
  for (let at = 0; at < running.length; at++) {
    const task = running[at]
    if (task !== null) await task
    const slot = slots[at]
    if (report !== null && slot.report !== null) report.absorb(slot.report)
    if (emit !== null && slot.emit !== null) emit.push(...slot.emit)
  }
  for (const [id, err] of errors) {
    process.stderr.write(
      `ERROR [${id}] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    )
  }
  return errors.length
}

export async function runTarget(
  target: Target,
  cases: Case[],
  root: string,
  report: Report | null,
  emit: EmitRow[] | null,
): Promise<void> {
  // A console block is only wired into the ram opener; refusing it
  // anywhere else keeps a silently RAM-consoled "redis console" target
  // from reading as covered.
  if (target.console !== undefined && target.mounts[0].vfs !== 'ram') {
    throw new Error(`target ${target.id}: console targets ride ram mounts`)
  }
  // The secrets env block is wired into the ram opener alone, for the
  // console block's reason: a target that declares one on an opener
  // that drops it would run with no managed vars and read as covered.
  if (target.secrets !== undefined && target.mounts[0].vfs !== 'ram') {
    throw new Error(`target ${target.id}: secrets targets ride ram mounts`)
  }
  // Profiles reach the workspace only through the openers that pass them
  // on, for the same reason: a target that declares one on an opener
  // that drops it would run unbound and read as covered. Python needs no
  // such list because it builds every target's workspace in one place.
  const PROFILE_OPENERS = ['ram', 'disk', 'email']
  const declaresProfiles = target.profiles !== undefined || target.profile !== undefined
  if (declaresProfiles && !PROFILE_OPENERS.includes(target.mounts[0].vfs)) {
    throw new Error(`target ${target.id}: profiles ride ${PROFILE_OPENERS.join(', ')} mounts`)
  }
  const { ws, cleanup } = await ADAPTERS[target.mounts[0].vfs](target)
  try {
    // A target's declared environment. A CLI whose spec reads a variable
    // (ntn's --notion-version off NOTION_API_VERSION) behaves differently with
    // and without it, so the conformance runner passes the same map to the real
    // binary and the comparison stays like for like.
    // Through the setter, not into the record: `ws.env` is a frozen
    // projection of the variable records, and a target's declared
    // environment is exported by definition -- a CLI reads it as a
    // process environment, which carries exported names only. Only when
    // declared: the setter rebuilds the var table from the projection,
    // which would drop a secrets target's managed pointers and preset
    // attributes.
    if (target.env !== undefined) ws.env = { ...ws.env, ...target.env }
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
      if (c.read !== undefined) continue
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
        )
      }
    }
  } finally {
    await cleanup()
  }
  const scenarios = cases.filter(
    (c) => c.targets.includes(target.id) && c.read !== undefined && c.scenario !== undefined,
  )
  for (const c of scenarios) {
    // Through the coercer, not a ternary: a typo'd or future policy name
    // would otherwise run the bounded scenario and report it green, which
    // is the silent downgrade this suite exists to catch.
    const spec: ReadSpec = resolveReadSpec(c.read, c.ttl)
    const opened = await openConsistency(target, spec)
    if (opened === null) {
      // Loud on purpose: an adapter that cannot build a shadow workspace used
      // to drop every scenario case for its target without a word.
      process.stderr.write(
        `skip [${target.id}] ${c.id}: ${target.mounts[0].vfs} adapter has no shadow workspace\n`,
      )
      continue
    }
    try {
      // Same rule as the ordinary path: a target's declared environment reaches
      // every workspace a case can run against, or a consistency scenario would
      // silently run under a different one.
      opened.ws.env = { ...opened.ws.env, ...(target.env ?? {}) }
      const { exitCode, out } = await runScenario(opened.ws, opened.mutate, c.scenario)
      if (emit !== null) {
        emit.push({ target: target.id, id: c.id, exit: exitCode, stdout: out, stderr: '' })
      } else if (report !== null) {
        report.record(target.id, c.id, compare(c, exitCode, out, '', 0))
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

  const { targets, emit: emitPath, facet, strict, allowSkip, targetJobs } = parseArgs()
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
    if (!(target.mounts[0].vfs in ADAPTERS)) {
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

  // One worker means the old loop, unchanged. The pool cannot stand in for
  // it: a target waiting on a busy lane lets a later one take the worker
  // first, so the default run would quietly reorder itself.
  let threw = 0
  if (targetJobs === 1) {
    for (const target of eligible) await runTarget(target, cases, root, report, emit)
  } else {
    threw = await runPool(eligible, cases, root, report, emit, services, targetJobs)
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
    // No file, deliberately, where the report path prints partial counts:
    // parity.py diffs two emits by (target, id), so a short one reads as a
    // pile of ONLY-PY/ONLY-TS rows rather than as the run that broke.
    if (threw) {
      process.stderr.write(`${String(threw)} target(s) failed to run\n`)
      process.exit(1)
    }
    writeFileSync(emitPath, JSON.stringify(emit))
    return
  }
  if (report === null) return
  process.stdout.write(`\n${report.summary()}\n`)
  if (threw) {
    process.stderr.write(`${String(threw)} target(s) failed to run\n`)
    process.exit(1)
  }
  if (report.failed) process.exit(1)
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + '\n')
  process.exit(1)
})
