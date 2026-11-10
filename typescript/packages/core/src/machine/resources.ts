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

import type { CpuShares, MachineResources, TaskCounts } from '../execution/types.ts'
import { RESOURCE_MARK } from './constants.ts'

const SWAP_UNITS: Readonly<Record<string, number>> = {
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
}
const SWAP_FIELD = /(total|used|free) = ([0-9.]+)([KMG])/g
const BOOT_SECONDS = /sec = ([0-9]+)/
const PAGE_SIZE = /page size of ([0-9]+)/
const VM_FIELD = /^(.*?):\s+([0-9]+)\.$/
const PROCESS_COUNT = /([0-9]+) (total|running|sleeping|stuck)/g
const CPU_SHARE = /([0-9.]+)% (user|sys|idle)/g

/** A line's marked rows: the last value of each key, and every pair in order. */
function rowsOf(text: string): [Map<string, string>, [string, string][]] {
  const facts = new Map<string, string>()
  const rows: [string, string][] = []
  for (const line of text.split('\n')) {
    const space = line.indexOf(' ')
    if (space < 0 || line.slice(0, space) !== RESOURCE_MARK) continue
    const rest = line.slice(space + 1)
    const gap = rest.indexOf(' ')
    const key = gap < 0 ? rest : rest.slice(0, gap)
    const value = gap < 0 ? '' : rest.slice(gap + 1)
    facts.set(key, value)
    rows.push([key, value])
  }
  return [facts, rows]
}

function need(facts: Map<string, string>, key: string): string {
  const value = facts.get(key)
  if (value === undefined) throw new Error(`no ${key} row`)
  return value
}

/** What `lscpu` printed, as it printed it. */
function cpuInfo(rows: readonly [string, string][]): string {
  return rows
    .filter(([key]) => key === 'lscpu')
    .map(([, value]) => `${value}\n`)
    .join('')
}

function words(text: string): string[] {
  return text.trim().split(/\s+/)
}

function timeFacts(facts: Map<string, string>): [number, string, string] {
  const [epoch = '', clock = '', offset = ''] = words(need(facts, 'clock'))
  return [Number(epoch), clock, offset]
}

function loadOf(text: string): [number, number, number] {
  const [one = '', five = '', fifteen = ''] = words(text)
  return [Number(one), Number(five), Number(fifteen)]
}

function shares(before: string, after: string): CpuShares {
  const first = words(before).slice(1, 9).map(Number)
  const second = words(after).slice(1, 9).map(Number)
  const spent = second.map((value, at) => value - (first[at] ?? 0))
  const whole = spent.reduce((sum, value) => sum + value, 0) || 1
  const [
    user = 0,
    nice = 0,
    system = 0,
    idle = 0,
    wait = 0,
    hardware = 0,
    software = 0,
    stolen = 0,
  ] = spent.map((share) => (100 * share) / whole)
  return { user, system, idle, nice, wait, hardware, software, stolen }
}

function tasksOf(states: string): TaskCounts {
  const countOf = (letter: string): number => states.split(letter).length - 1
  const running = countOf('R')
  const stopped = countOf('T') + countOf('t')
  const zombie = countOf('Z')
  const total = states.length
  return { total, running, sleeping: total - running - stopped - zombie, stopped, zombie }
}

/**
 * What `resourcesLine` printed on a Linux machine. Mirrors Python's
 * `parse_resources`.
 *
 * @param text what it printed.
 * @param machine the machine, as `ps` shows it.
 */
export function parseResources(text: string, machine: string): MachineResources {
  const [facts, rows] = rowsOf(text)
  const memory = new Map<string, number>()
  for (const [key, value] of rows) {
    if (key !== 'mem') continue
    const gap = value.indexOf(' ')
    const name = gap < 0 ? value : value.slice(0, gap)
    const size = gap < 0 ? '' : value.slice(gap + 1)
    if (/^[0-9]+$/.test(size)) memory.set(name.replace(/:$/, ''), Number(size) * 1024)
  }
  const size = (name: string): number => memory.get(name) ?? 0
  const needed = (name: string): number => {
    const value = memory.get(name)
    if (value === undefined) throw new Error(`no ${name} row`)
    return value
  }
  const [epoch, clock, offset] = timeFacts(facts)
  const [cpus = '', allCpus = ''] = words(need(facts, 'cpus'))
  const free = needed('MemFree')
  const total = needed('MemTotal')
  const cached = size('Cached') + size('SReclaimable')
  const buffers = size('Buffers')
  const before = facts.get('before')
  const after = facts.get('after')
  const states = facts.get('states')
  return {
    machine,
    cpus: Number(cpus),
    allCpus: Number(allCpus),
    epoch,
    clock,
    offset,
    upSeconds: Number(need(facts, 'up')),
    load: loadOf(need(facts, 'load')),
    users: Number(facts.get('users') ?? '') || 0,
    memTotal: total,
    memFree: free,
    memAvailable: memory.get('MemAvailable') ?? free + cached + buffers,
    swapTotal: size('SwapTotal'),
    swapFree: size('SwapFree'),
    shared: size('Shmem'),
    buffers,
    cached,
    commitLimit: size('CommitLimit'),
    committed: size('Committed_AS'),
    lowTotal: memory.get('LowTotal') ?? total,
    lowFree: memory.get('LowFree') ?? free,
    highTotal: size('HighTotal'),
    highFree: size('HighFree'),
    tasks: states === undefined ? null : tasksOf(states),
    cpu: before === undefined || after === undefined ? null : shares(before, after),
    hostname: facts.get('host') ?? '',
    cpuInfo: cpuInfo(rows),
  }
}

function darwinTasks(line: string): TaskCounts {
  const counts = new Map<string, number>()
  for (const [, count = '', name = ''] of line.matchAll(PROCESS_COUNT))
    counts.set(name, Number(count))
  return {
    total: counts.get('total') ?? 0,
    running: counts.get('running') ?? 0,
    sleeping: counts.get('sleeping') ?? 0,
    stopped: 0,
    zombie: 0,
  }
}

function darwinShares(line: string): CpuShares {
  const found = new Map<string, number>()
  for (const [, share = '', name = ''] of line.matchAll(CPU_SHARE)) found.set(name, Number(share))
  return {
    user: found.get('user') ?? 0,
    system: found.get('sys') ?? 0,
    idle: found.get('idle') ?? 0,
    nice: null,
    wait: null,
    hardware: null,
    software: null,
    stolen: null,
  }
}

/**
 * What `darwinResourcesLine` printed on a Mac. Inactive and speculative pages
 * are the cache, which memory pressure takes back, so they count as
 * available, as Linux's cache does. Mirrors Python's
 * `parse_darwin_resources`.
 *
 * @param text what it printed.
 * @param machine the machine, as `ps` shows it.
 */
export function parseDarwinResources(text: string, machine: string): MachineResources {
  const [facts, rows] = rowsOf(text)
  let page = 4096
  const pages = new Map<string, number>()
  let tasks: TaskCounts | null = null
  let cpu: CpuShares | null = null
  for (const [key, value] of rows) {
    if (key === 'vm') {
      const size = PAGE_SIZE.exec(value)
      const field = VM_FIELD.exec(value)
      if (size !== null) page = Number(size[1])
      else if (field !== null) pages.set(field[1] ?? '', Number(field[2]))
    } else if (key === 'top' && value.startsWith('Processes:')) {
      tasks = darwinTasks(value)
    } else if (key === 'top' && value.startsWith('CPU usage:')) {
      cpu = darwinShares(value)
    }
  }
  const swap = new Map<string, number>()
  for (const [, name = '', amount = '', unit = ''] of need(facts, 'swap').matchAll(SWAP_FIELD))
    swap.set(name, Math.trunc(Number(amount) * (SWAP_UNITS[unit] ?? 1)))
  const boot = BOOT_SECONDS.exec(need(facts, 'boot'))
  if (boot === null) throw new Error('no boot time')
  const [epoch, clock, offset] = timeFacts(facts)
  const freePages = pages.get('Pages free')
  if (freePages === undefined) throw new Error('no free pages')
  const free = freePages * page
  const cache = ((pages.get('Pages inactive') ?? 0) + (pages.get('Pages speculative') ?? 0)) * page
  const [cpus = '', allCpus = ''] = words(need(facts, 'cpus'))
  return {
    machine,
    cpus: Number(cpus),
    allCpus: Number(allCpus),
    epoch,
    clock,
    offset,
    upSeconds: Math.max(0, epoch - Number(boot[1])),
    load: loadOf(need(facts, 'load').replace(/[{}]/g, '')),
    users: Number(facts.get('users') ?? '') || 0,
    memTotal: Number(need(facts, 'memsize')),
    memFree: free,
    memAvailable: free + cache,
    swapTotal: swap.get('total') ?? 0,
    swapFree: swap.get('free') ?? 0,
    shared: null,
    buffers: null,
    cached: cache,
    commitLimit: null,
    committed: null,
    lowTotal: null,
    lowFree: null,
    highTotal: null,
    highFree: null,
    tasks,
    cpu,
    hostname: facts.get('host') ?? '',
    cpuInfo: cpuInfo(rows),
  }
}
