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
  bindMount,
  compare,
  integRoot,
  loadCases,
  loadServices,
  loadTargets,
  missingEnv,
  parseAllowSkip,
  ruleReasons,
  runCase,
  runScenario,
  scenarioVerb,
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
  // argparse takes `--opt value` and `--opt=value` alike, and refuses a word
  // it does not know. An exact-string check saw only the first spelling and
  // every other word was dropped in silence, so `--target-jobs=4` ran serially
  // without saying so. Split the equals form here and the arms below stay one
  // comparison each.
  //
  // One deliberate divergence, and it is the only one left: argparse defaults
  // to `allow_abbrev=True`, so `--fac core` and `--prof` reach the python
  // runner as `--facet` and `--profile`, and an ambiguous prefix like `--targ`
  // is its own error naming both candidates. This runner refuses all three as
  // unrecognized. Prefix matching plus ambiguity reporting is a good deal more
  // machinery than a CI runner's option list is worth, and the divergence
  // fails loudly on the stricter side: a line that works here works there,
  // never the reverse, so no invocation can silently mean two things. Every
  // line in .github/workflows spells its options in full.
  const argv: string[] = []
  // Parallel to argv: true where the word arrived as the right of an equals,
  // which is the one way argparse lets a value look like an option.
  const literal: boolean[] = []
  for (const raw of process.argv.slice(2)) {
    const eq = /^(--[a-z][a-z-]*)=([\s\S]*)$/.exec(raw)
    if (eq === null) {
      argv.push(raw)
      literal.push(false)
    } else {
      argv.push(eq[1] as string, eq[2] as string)
      literal.push(false, true)
    }
  }
  const refuse = (message: string): never => {
    process.stderr.write(`${message}\n`)
    process.exit(2)
  }
  // Wording and exit code are argparse's, because the two runners are held to
  // the same line and a difference here is a difference in what CI accepts.
  // These three rules are copied off `_parse_optional` rather than guessed: a
  // one-character token, a negative number, and a token holding a space are
  // all values, however much they look like options. NEGATIVE_NUMBER is
  // argparse's `_negative_number_matcher` verbatim, so `-.5` and `-0.5` are
  // values while `-5.` and `-1e5` are not.
  const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/
  const optionLike = (w: string): boolean =>
    w.startsWith('-') && w.length > 1 && !NEGATIVE_NUMBER.test(w) && !w.includes(' ')
  const value = (at: number, name: string): string => {
    const v = argv[at + 1]
    if (v === undefined) refuse(`argument ${name}: expected one argument`)
    if (literal[at + 1] !== true && optionLike(v as string)) {
      refuse(`argument ${name}: expected one argument`)
    }
    return v as string
  }
  // argparse supplies -h/--help for free, so the python runner has always had
  // it and this one never did. Rejecting unknown words made that silence into
  // an error, which is worse: the option list is the only place the flags this
  // runner takes are written down. Same text argparse renders, same exit 0.
  const usage = [
    'usage: main.ts [-h] [--target TARGETS] [--facet FACET] [--emit EMIT]',
    '               [--strict] [--allow-skip ALLOW_SKIP]',
    '               [--target-jobs TARGET_JOBS] [--profile]',
    '',
    'options:',
    '  -h, --help            show this help message and exit',
    '  --target TARGETS',
    '  --facet FACET',
    '  --emit EMIT',
    '  --strict',
    '  --allow-skip ALLOW_SKIP',
    '  --target-jobs TARGET_JOBS',
    '  --profile',
    '',
  ].join('\n')
  // A zero-argument option takes no value, and argparse says so rather than
  // ignoring one: `--strict=foo` and `--help=foo` are both refused. The
  // equals split above turned such a line into two words, which for --strict
  // happened to fail anyway on the stray word but for --help exited 0 before
  // anything else was read.
  const noValue = (at: number, name: string): void => {
    if (literal[at + 1] === true) {
      refuse(`argument ${name}: ignored explicit argument '${argv[at + 1] as string}'`)
    }
  }
  // argparse walks the line once, left to right, and the order of its two
  // error kinds is observable. An error raised while consuming an option
  // (`ignored explicit argument`, `invalid int value`, `expected one
  // argument`) fires there and then, so it beats a `--help` further right.
  // `unrecognized arguments` does not: it is reported after the whole walk,
  // so any help flag anywhere beats it. Refusing unknown words inline made
  // `main.ts x --help` complain about `x`; refusing them before the walk made
  // `--strict=foo --help` print usage. Collect them and report at the end.
  const unknown: string[] = []
  // `--` ends the options. Everything after it is a positional, and this
  // parser declares none, so the separator and its tail all land in `unknown`
  // and are reported together. That is why a `--help` to the right of a `--`
  // is a stray word rather than a request for usage.
  let endOfOptions = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (endOfOptions) {
      unknown.push(arg)
      continue
    }
    if (arg === '--') {
      endOfOptions = true
      unknown.push(arg)
      continue
    }
    if (arg === '-h' || arg === '--help') {
      noValue(i, '-h/--help')
      process.stdout.write(usage)
      process.exit(0)
    } else if (arg === '--strict') {
      noValue(i, arg)
      strict = true
    } else if (arg === '--profile') {
      noValue(i, arg)
      profile = true
    } else if (arg === '--target') {
      targets.push(value(i, arg))
      i += 1
    } else if (arg === '--facet') {
      facet = value(i, arg)
      i += 1
    } else if (arg === '--emit') {
      emit = value(i, arg)
      i += 1
    } else if (arg === '--allow-skip') {
      allowSkip = value(i, arg)
      i += 1
    } else if (arg === '--target-jobs') {
      const raw = value(i, arg)
      i += 1
      // `Number()` is far looser than python's `int()`, so it took `4.0`,
      // `1e1` and `0x4` where the other runner refuses all three. Probed:
      // int() allows surrounding whitespace, a sign, leading zeros and
      // underscores between digits, and nothing else. The one spelling not
      // matched here is a non-ASCII digit (int('\u0664') is 4), which no CI
      // line will carry and which JS has no cheap equivalent for.
      const decimal = /^[+-]?\d+(?:_\d+)*$/.exec(raw.trim())
      if (decimal === null) {
        refuse(`argument --target-jobs: invalid int value: '${raw}'`)
      }
      targetJobs = Number(raw.trim().replace(/_/g, ''))
    } else unknown.push(arg)
  }
  // Space-joined, as argparse joins them: a line with two stray words names
  // both rather than stopping at the first.
  if (unknown.length > 0) refuse(`unrecognized arguments: ${unknown.join(' ')}`)
  // Last, because it is not argparse's. `0` is a valid int, so the python
  // runner parses the line, prints help or reports a stray word, and only
  // then reaches its own floor check. Refusing inline made `--target-jobs 0
  // -h` an error where the other runner prints usage.
  if (targetJobs < 1) refuse('--target-jobs takes an integer >= 1')
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
      const caseStarted = performance.now()
      const { exitCode, out, err, elapsed, checkOut, notes } = await runCase(ws, bound, reasons)
      // Two durations, deliberately. `elapsed` is the command alone and is what
      // a case's `expect.elapsed` bounds are asserted against, so it cannot
      // grow. `whole` is the whole case, which for the 34 cases carrying a
      // `check` includes a second backend read the command-only figure left
      // out; without it that work fell into the wall-minus-cases gap and read
      // as setup.
      const whole = (performance.now() - caseStarted) / 1000
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
          whole,
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
        report.record(
          target.id,
          c.id,
          compare(c, exitCode, out, '', elapsed),
          elapsed,
          scenarioVerb(c),
        )
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
      const started = performance.now()
      await runTarget(target, cases, root, report, emit)
      report?.noteTargetWall(target.id, (performance.now() - started) / 1000)
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
    // One slot per invocation, not per target id. `--target x --target x` is
    // two runs, and keying by id made the merge below read the second slot
    // twice and drop the first.
    const slots: { report: Report | null; emit: EmitRow[] | null }[] = []
    const chain: Promise<void>[] = []
    for (const target of eligible) {
      const slot = {
        report: report === null ? null : new Report(false),
        emit: emit === null ? null : ([] as EmitRow[]),
      }
      slots.push(slot)
      const lane = target.service ?? `solo:${target.id}`
      const prev = lanes.get(lane) ?? Promise.resolve()
      const next = prev.then(async () => {
        await acquire()
        const started = performance.now()
        try {
          await runTarget(target, cases, root, slot.report, slot.emit)
        } catch (err) {
          errors.push(err)
        } finally {
          slot.report?.noteTargetWall(target.id, (performance.now() - started) / 1000)
          release()
        }
      })
      lanes.set(lane, next)
      chain.push(next)
    }
    await Promise.all(chain)
    // Merged in declared target order, so a concurrent run prints what a serial
    // run printed.
    for (const slot of slots) {
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
