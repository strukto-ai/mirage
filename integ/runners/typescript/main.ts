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
  loadTargets,
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
}

function parseArgs(): { targets: string[]; emit: string | undefined; facet: string | undefined } {
  const targets: string[] = []
  let emit: string | undefined
  let facet: string | undefined
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && i + 1 < argv.length) targets.push(argv[++i])
    else if (argv[i] === '--facet' && i + 1 < argv.length) facet = argv[++i]
    else if (argv[i] === '--emit' && i + 1 < argv.length) emit = argv[++i]
  }
  return { targets, emit, facet }
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
    for (const mount of target.mounts) {
      await seedFixture(ws, mount.fixture, mount.path, root)
      if (mount.seed_root) await seedMountRoot(ws, mount.path)
    }
    // Sessions a case can name via its `session` field. Mount grants take
    // either the mapping form ({ '/data': 'read' }) or the list form
    // (['/data'], which inherits the mount's own mode).
    for (const [sessionId, mounts] of Object.entries(target.sessions ?? {})) {
      ws.createSession(sessionId, { mounts })
    }
    for (const c of cases) {
      if (!c.targets.includes(target.id)) continue
      if (c.consistency !== undefined) continue
      const bound = bindMount(c, target.mounts[0].path)
      const { exitCode, out, err, elapsed } = await runCase(ws, bound)
      if (emit !== null) {
        emit.push({ target: target.id, id: bound.id, exit: exitCode, stdout: out, stderr: err })
      } else if (report !== null) {
        report.record(target.id, bound.id, compare(bound, exitCode, out, err, elapsed))
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
  const cases = loadCases(root)

  const { targets, emit: emitPath, facet } = parseArgs()
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
    if (target.service === 's3' && !process.env.S3_ENDPOINT) {
      process.stderr.write(`skip [${id}]: S3_ENDPOINT not set\n`)
      continue
    }
    if (target.service === 'databricks' && !process.env.DATABRICKS_ENDPOINT) {
      process.stderr.write(`skip [${id}]: DATABRICKS_ENDPOINT not set\n`)
      continue
    }
    if (target.service === 'ssh' && !process.env.SSH_HOST) {
      process.stderr.write(`skip [${id}]: SSH_HOST not set\n`)
      continue
    }
    if (target.service === 'nextcloud' && !process.env.NEXTCLOUD_URL) {
      process.stderr.write(`skip [${id}]: NEXTCLOUD_URL not set\n`)
      continue
    }
    if (target.service === 'gws' && !process.env.GWS_URL) {
      process.stderr.write(`skip [${id}]: GWS_URL not set\n`)
      continue
    }
    if (target.service === 'email' && !process.env.EMAIL_HOST) {
      process.stderr.write(`skip [${id}]: EMAIL_HOST not set\n`)
      continue
    }
    if (target.service === 'hf' && !process.env.HF_ENDPOINT) {
      process.stderr.write(`skip [${id}]: HF_ENDPOINT not set\n`)
      continue
    }
    if (target.service === 'box' && !process.env.BOX_ENDPOINT) {
      process.stderr.write(`skip [${id}]: BOX_ENDPOINT not set\n`)
      continue
    }
    if (
      (target.service === 'github' || target.service === 'github_ci') &&
      !process.env.GITHUB_URL
    ) {
      process.stderr.write(`skip [${id}]: GITHUB_URL not set\n`)
      continue
    }
    if (target.service === 'slack' && !process.env.SLACK_URL) {
      process.stderr.write(`skip [${id}]: SLACK_URL not set\n`)
      continue
    }
    if (target.service === 'trello' && !process.env.TRELLO_ENDPOINT) {
      process.stderr.write(`skip [${id}]: TRELLO_ENDPOINT not set\n`)
      continue
    }
    if (target.service === 'discord' && !process.env.DISCORD_ENDPOINT) {
      process.stderr.write(`skip [${id}]: DISCORD_ENDPOINT not set\n`)
      continue
    }
    if (target.service === 'linear' && !process.env.LINEAR_ENDPOINT) {
      process.stderr.write(`skip [${id}]: LINEAR_ENDPOINT not set\n`)
      continue
    }
    if (target.service === 'postgres' && !process.env.POSTGRES_DSN) {
      process.stderr.write(`skip [${id}]: POSTGRES_DSN not set\n`)
      continue
    }
    if (target.service === 'mongodb' && !process.env.MONGODB_URI) {
      process.stderr.write(`skip [${id}]: MONGODB_URI not set\n`)
      continue
    }
    if (target.service === 'chroma' && !process.env.CHROMA_HOST) {
      process.stderr.write(`skip [${id}]: CHROMA_HOST not set\n`)
      continue
    }
    if (target.service === 'qdrant' && !process.env.QDRANT_HOST) {
      process.stderr.write(`skip [${id}]: QDRANT_HOST not set\n`)
      continue
    }
    if (target.service === 'lancedb' && !process.env.LANCEDB_ENABLED) {
      process.stderr.write(`skip [${id}]: LANCEDB_ENABLED not set\n`)
      continue
    }
    if (target.service === 'notion' && !process.env.NOTION_ENABLED) {
      process.stderr.write(`skip [${id}]: NOTION_ENABLED not set\n`)
      continue
    }
    if (target.service === 'jaeger' && !process.env.JAEGER_URL) {
      process.stderr.write(`skip [${id}]: JAEGER_URL not set\n`)
      continue
    }
    if (target.service === 'langfuse' && !process.env.LANGFUSE_URL) {
      process.stderr.write(`skip [${id}]: LANGFUSE_URL not set\n`)
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
