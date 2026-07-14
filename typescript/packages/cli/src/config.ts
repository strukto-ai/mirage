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

import { ALLOWED_KEYS, DaemonConfigError } from '@struktoai/mirage-server'
import type { Command } from 'commander'
import { emit, fail } from './output.ts'
import { getConfig, listConfig, resolvedConfig, setConfig, unsetConfig } from './settings.ts'

function mask(key: string, value: string): string {
  if (key === 'auth_token' && value !== '') return '***'
  return value
}

interface ResolvedEntry {
  value: string
  origin: string
}

function humanTable(table: Record<string, string>): string {
  return Object.entries(table)
    .map(([k, v]) => `${k} = ${v}`)
    .join('\n')
}

function humanResolved(table: Record<string, ResolvedEntry>): string {
  return Object.entries(table)
    .map(([k, e]) => `${k} = ${e.value}  (${e.origin})`)
    .join('\n')
}

function listResolved(): void {
  let resolved: Record<string, [string, string]>
  try {
    resolved = resolvedConfig()
  } catch (e) {
    fail((e as Error).message, 2)
    return
  }
  const payload: Record<string, ResolvedEntry> = {}
  for (const [key, [value, origin]] of Object.entries(resolved)) {
    payload[key] = { value: mask(key, value), origin }
  }
  emit(payload, humanResolved)
}

function listFile(): void {
  let table: Record<string, string>
  try {
    table = listConfig()
  } catch (e) {
    if (!(e instanceof DaemonConfigError)) throw e
    fail(e.message, 2)
    return
  }
  const unknown = Object.keys(table)
    .filter((k) => !ALLOWED_KEYS.has(k))
    .sort()
  if (unknown.length > 0) {
    process.stderr.write(
      'warning: unknown [daemon] keys (daemon will refuse to ' + `start): ${unknown.join(', ')}\n`,
    )
  }
  emit(table, humanTable)
}

export function registerConfigCommands(program: Command): void {
  const config = program
    .command('config')
    .description('Read and write daemon settings in config.toml.')

  config
    .command('list')
    .option('--resolved', 'show effective values and their origins')
    .description('Print the config.toml [daemon] table.')
    .action((opts: { resolved?: boolean }) => {
      if (opts.resolved === true) listResolved()
      else listFile()
    })

  config
    .command('get')
    .argument('<key>')
    .description('Print one [daemon] key.')
    .action((key: string) => {
      let value: string | undefined
      try {
        value = getConfig(key)
      } catch (e) {
        fail((e as Error).message, 2)
        return
      }
      if (value === undefined) {
        fail(`${key} is not set`, 1)
        return
      }
      emit({ [key]: value }, () => value)
    })

  config
    .command('set')
    .argument('<key>')
    .argument('<value>')
    .description('Write a [daemon] key (path settings apply on next daemon restart).')
    .action((key: string, value: string) => {
      try {
        setConfig(key, value)
      } catch (e) {
        fail((e as Error).message, 2)
        return
      }
      emit({ [key]: value, written: true }, () => `${key} = ${value}`)
    })

  config
    .command('unset')
    .argument('<key>')
    .description('Remove a [daemon] key.')
    .action((key: string) => {
      try {
        unsetConfig(key)
      } catch (e) {
        fail((e as Error).message, 2)
        return
      }
      emit({ [key]: null, unset: true }, () => `unset ${key}`)
    })
}
