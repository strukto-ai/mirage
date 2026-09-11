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
// spelling through the rename map `spec/typescript/node/resources.json`
// records for the resource, so one expectation serves both hosts and the
// committed spec is exercised rather than trusted.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildResource } from '@struktoai/mirage-node'

const HOST = 'typescript'
const HERE = dirname(fileURLToPath(import.meta.url))
const SUITE = join(HERE, 'cases.json')
const SPEC = join(HERE, '..', '..', 'spec', 'typescript', 'node', 'resources.json')

interface Case {
  id: string
  hosts?: string[]
  resource: string
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
function wireName(resource: string, field: string): string {
  const rename = SPEC_CONFIGS[resource]?.rename ?? {}
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

async function run(testCase: Case): Promise<string[]> {
  let resource
  try {
    resource = await buildResource(testCase.resource, { ...testCase.config })
  } catch (err) {
    return problems(testCase, null, err instanceof Error ? err.message : String(err))
  }
  const state = (await resource.getState()) as { config?: unknown }
  const closer = (resource as { close?: () => unknown }).close
  if (typeof closer === 'function') await closer.call(resource)
  const config = state.config
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return problems(testCase, null, null)
  }
  const folded: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    folded[wireName(testCase.resource, key)] = value
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
