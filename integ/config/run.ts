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

// The config-plane suite, TypeScript host. See run.py for what it proves.
// State keys come back camelCase here and are folded to python's wire
// spelling through the rename map `.cache/spec/typescript/node/vfs.json`
// records for the VFS, so one expectation serves both hosts and the
// live registry metadata is exercised rather than trusted.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import {
  buildVfs,
  configToWorkspaceArgs,
  loadWorkspaceConfig,
  Workspace,
} from '@struktoai/mirage-node'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { apiRequest } from '@struktoai/mirage-core/core/api/client'
import type { PathSpec } from '@struktoai/mirage-core/types'

const HOST = 'typescript'
const HERE = dirname(fileURLToPath(import.meta.url))
const SUITE = join(HERE, 'cases.json')
const SPEC = join(
  process.env.MIRAGE_SPEC_DIR ?? join(HERE, '..', '..', '.cache', 'spec'),
  'typescript',
  'node',
  'vfs.json',
)

interface Case {
  id: string
  hosts?: string[]
  vfs: string
  body_bytes?: number
  config: Record<string, unknown>
  expect: { refused?: string; state?: Record<string, unknown>; absent?: string[] }
}

interface Suite {
  suite: string
  cases: Case[]
}

interface ConfigFacts {
  rename: Record<string, string>
}

const SPEC_CONFIGS = (
  JSON.parse(readFileSync(SPEC, 'utf8')) as { configs: Record<string, ConfigFacts | null> }
).configs

function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

// A TypeScript field's python wire name: the rename map inverted, else the
// default camelCase fold undone.
function wireName(vfs: string, field: string): string {
  const rename = SPEC_CONFIGS[vfs]?.rename ?? {}
  for (const [wire, camel] of Object.entries(rename)) if (camel === field) return wire
  return camelToSnake(field)
}

function problems(
  testCase: Case,
  state: Record<string, unknown> | null,
  error: string | null,
): string[] {
  const label = `config/${testCase.id}`
  const expect = testCase.expect
  if (expect.refused !== undefined) {
    if (error === null) {
      return [
        `${label}: expected a refusal containing ${JSON.stringify(expect.refused)}, but the config was accepted`,
      ]
    }
    if (!error.includes(expect.refused)) {
      return [
        `${label}: refusal ${JSON.stringify(error)} does not contain ${JSON.stringify(expect.refused)}`,
      ]
    }
    return []
  }
  if (error !== null) return [`${label}: expected the config to be accepted, refused with ${error}`]
  if (state === null) return [`${label}: state carries no config mapping`]
  const out: string[] = []
  for (const [key, want] of Object.entries(expect.state ?? {})) {
    if (!(key in state)) out.push(`${label}: state lacks ${JSON.stringify(key)}`)
    else if (JSON.stringify(state[key]) !== JSON.stringify(want)) {
      out.push(
        `${label}: state[${JSON.stringify(key)}] = ${JSON.stringify(state[key])}, expected ${JSON.stringify(want)}`,
      )
    }
  }
  for (const key of expect.absent ?? []) {
    if (key in state) {
      out.push(
        `${label}: state carries ${JSON.stringify(key)} = ${JSON.stringify(state[key])}, expected it dropped`,
      )
    }
  }
  return out
}

class BodyRAM extends RAMVFS {
  constructor(readonly url: string) {
    super()
  }

  override async read(_path: PathSpec): Promise<Uint8Array> {
    const text = await apiRequest('GET', this.url, {
      read: 'text',
      errorOf: (response) => new Error(String(response.status)),
    })
    if (typeof text !== 'string') throw new Error('expected text')
    return new TextEncoder().encode(text)
  }
}

async function workspace(testCase: Case): Promise<string[]> {
  let args
  try {
    args = await configToWorkspaceArgs(loadWorkspaceConfig(testCase.config))
  } catch (error) {
    return problems(testCase, null, error instanceof Error ? error.message : String(error))
  }
  if (testCase.body_bytes === undefined) {
    const ws = new Workspace(args.mounts, args.options)
    try {
      return problems(testCase, { max_body_bytes: ws.registry.bodyLimit }, null)
    } finally {
      await ws.close()
    }
  }
  let hits = 0
  const server = createServer((_request, response) => {
    hits += 1
    response.end('x'.repeat(testCase.body_bytes ?? 0))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing fixture port')
  const ws = new Workspace(
    { '/body': new BodyRAM(`http://127.0.0.1:${String(address.port)}`) },
    args.options,
  )
  try {
    await ws.vfs.write('/body/file', new Uint8Array())
    const result = await ws.shell('cat /body/file')
    if (hits === 0) throw new Error('the mount read never reached the service')
    const decode = new TextDecoder()
    return problems(
      testCase,
      {
        stdout: decode.decode(result.stdout),
        stderr: decode.decode(result.stderr),
        exit_code: result.exitCode,
      },
      null,
    )
  } finally {
    await ws.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    )
  }
}

async function run(testCase: Case): Promise<string[]> {
  if (testCase.vfs === 'workspace') return workspace(testCase)
  let vfs
  try {
    vfs = await buildVfs(testCase.vfs, { ...testCase.config })
  } catch (err) {
    return problems(testCase, null, err instanceof Error ? err.message : String(err))
  }
  const state = (await vfs.getState()) as { config?: unknown }
  const closer = (vfs as { close?: () => unknown }).close
  if (typeof closer === 'function') await closer.call(vfs)
  const config = state.config
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return problems(testCase, null, null)
  }
  const folded: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    folded[wireName(testCase.vfs, key)] = value
  }
  return problems(testCase, folded, null)
}

async function main(): Promise<number> {
  const suite = JSON.parse(readFileSync(SUITE, 'utf8')) as Suite
  let passed = 0
  const failures: string[] = []
  for (const testCase of suite.cases) {
    if (!(testCase.hosts ?? ['python', 'typescript']).includes(HOST)) continue
    const found = await run(testCase)
    if (found.length > 0) {
      failures.push(...found)
      console.log(`FAIL config/${testCase.id}`)
    } else {
      passed += 1
      console.log(`ok config/${testCase.id}`)
    }
  }
  console.log(`\n${String(passed)} passed, ${String(failures.length)} failed`)
  for (const line of failures) console.log(`  ${line}`)
  return failures.length > 0 ? 1 : 0
}

process.exitCode = await main()
