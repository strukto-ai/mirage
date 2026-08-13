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
import { ADAPTERS, CONSISTENCY_ADAPTERS } from './adapters.ts'
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
} {
  const targets: string[] = []
  let emit: string | undefined
  let facet: string | undefined
  let strict = false
  let allowSkip = ''
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && i + 1 < argv.length) targets.push(argv[++i])
    else if (argv[i] === '--facet' && i + 1 < argv.length) facet = argv[++i]
    else if (argv[i] === '--emit' && i + 1 < argv.length) emit = argv[++i]
    else if (argv[i] === '--strict') strict = true
    else if (argv[i] === '--allow-skip' && i + 1 < argv.length) allowSkip = argv[++i]
  }
  return { targets, emit, facet, strict, allowSkip }
}

async function runTarget(
  target: Target,
  cases: Case[],
  root: string,
  report: Report | null,
  emit: EmitRow[] | null,
): Promise<void> {
  const { ws, cleanup } = await ADAPTERS[target.mounts[0].resource](target)
  try {
    // A target's declared environment. A CLI whose spec reads a variable
    // (ntn's --notion-version off NOTION_API_VERSION) behaves differently with
    // and without it, so the conformance runner passes the same map to the real
    // binary and the comparison stays like for like.
    Object.assign(ws.env, target.env ?? {})
    for (const mount of target.mounts) {
      await seedFixture(ws, mount.fixture, mount.path, root)
      if (mount.seed_root) await seedMountRoot(ws, mount.path)
    }
    // Sessions a case can name via its `session` field. Mount grants take
    // either the mapping form ({ '/data': 'read' }) or the list form
    // (['/data'], which inherits the mount's own mode). A profile form
    // ({ mounts, hidden_paths, hidden_vars, env }) narrows visibility
    // too; it is told apart by its keys, which never start with '/'.
    for (const [sessionId, spec] of Object.entries(target.sessions ?? {})) {
      const profileShaped =
        spec !== null &&
        typeof spec === 'object' &&
        !Array.isArray(spec) &&
        ['mounts', 'hidden_paths', 'hidden_vars', 'env'].some((k) => k in spec)
      if (profileShaped) {
        const p = spec as {
          mounts?: Record<string, string> | string[]
          hidden_paths?: { paths?: string[]; patterns?: string[] }
          hidden_vars?: { names?: string[]; patterns?: string[] }
          env?: Record<string, string>
        }
        ws.createSession(sessionId, {
          profile: {
            mounts: p.mounts ?? null,
            hiddenPaths:
              p.hidden_paths !== undefined
                ? { paths: p.hidden_paths.paths ?? [], patterns: p.hidden_paths.patterns ?? [] }
                : null,
            hiddenVars:
              p.hidden_vars !== undefined
                ? { names: p.hidden_vars.names ?? [], patterns: p.hidden_vars.patterns ?? [] }
                : null,
            env: p.env ?? null,
          },
        })
      } else {
        ws.createSession(sessionId, { mounts: spec as Record<string, string> | string[] })
      }
    }
    for (const c of cases) {
      if (!c.targets.includes(target.id)) continue
      if (c.consistency !== undefined) continue
      const bound = bindMount(c, target.mounts[0].path)
      const { exitCode, out, err, elapsed, checkOut } = await runCase(ws, bound)
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
        report.record(target.id, bound.id, compare(bound, exitCode, out, err, elapsed, checkOut))
      }
    }
  } finally {
    await cleanup()
  }
  const consistencyAdapter = CONSISTENCY_ADAPTERS[target.mounts[0].resource]
  if (consistencyAdapter === undefined) return
  for (const c of cases) {
    if (!c.targets.includes(target.id) || c.consistency === undefined || c.scenario === undefined) {
      continue
    }
    const policy =
      c.consistency === 'always' ? ConsistencyPolicy.ALWAYS : ConsistencyPolicy.LAZY
    const opened = await consistencyAdapter(target, policy)
    try {
      // Same rule as the ordinary path: a target's declared environment reaches
      // every workspace a case can run against, or a consistency scenario would
      // silently run under a different one.
      Object.assign(opened.ws.env, target.env ?? {})
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

  const { targets, emit: emitPath, facet, strict, allowSkip } = parseArgs()
  // Targets are grouped into facets so CI can run one backend family per job; a
  // target with no facet belongs to "core", which the shared battery runs.
  let ids: string[]
  if (facet !== undefined) {
    ids = [...manifest.entries()]
      .filter(([, t]) => (t.facet ?? 'core') === facet)
      .map(([id]) => id)
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
    await runTarget(target, cases, root, report, emit)
    ran += 1
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
  process.stdout.write(`\n${report.summary()}\n`)
  if (report.failed) process.exit(1)
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + '\n')
  process.exit(1)
})
