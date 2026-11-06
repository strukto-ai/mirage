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

import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import type { Command } from 'commander'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { type DaemonClient, makeClient } from './client.ts'
import { emit, fail, formatTable, handleResponse } from './output.ts'

/** One kind of saved connection: its command, route and noun. */
interface Kind {
  name: string
  route: string
  noun: string
}

const KINDS: readonly Kind[] = [
  { name: 'vfs', route: '/v1/vfs', noun: 'VFS' },
  { name: 'cli', route: '/v1/clis', noun: 'CLI' },
  { name: 'runtime', route: '/v1/runtimes', noun: 'runtime' },
]

const OUTPUTS: readonly string[] = ['json', 'yaml']

const NO_ARGV_SECRET = (key: string): string =>
  `a secret never comes from the command line: use --secret ${key} to be prompted ` +
  `(or to read stdin), or --secret ${key}=@FILE`

type Spec = {
  name: string
  type: string
  secret?: boolean
  required?: boolean
  group?: string
  default?: unknown
}[]

/** An entry as the flags and file build it, before it is sent. */
interface Draft {
  name?: string
  type?: string
  fields: Record<string, unknown>
  secrets: [string, string | null][]
  plain: Set<string>
}

const emptyDraft = (): Draft => ({ fields: {}, secrets: [], plain: new Set() })

/** A `--set key=value`: JSON when the value starts with `{` or `[`, else the string. */
export function setValue(word: string): [string, unknown] {
  const at = word.indexOf('=')
  if (at <= 0) fail(`--set ${word}: a field is key=value`, 2)
  const key = word.slice(0, at)
  const raw = word.slice(at + 1)
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return [key, JSON.parse(raw) as unknown]
    } catch (err) {
      fail(`--set ${key} is not valid JSON: ${String(err)}`, 2)
    }
  }
  return [key, raw]
}

/**
 * A `--secret key` or `--secret key=@FILE`: the key and the file to read, or
 * null to prompt or read stdin. A value written on the command line is refused.
 */
export function secretSource(word: string): [string, string | null] {
  const at = word.indexOf('=')
  const key = at < 0 ? word : word.slice(0, at)
  if (key === '') fail(`--secret ${word}: name a field`, 2)
  if (at < 0) return [key, null]
  const raw = word.slice(at + 1)
  if (!raw.startsWith('@') || raw === '@') fail(NO_ARGV_SECRET(key), 2)
  return [key, raw.slice(1)]
}

/** A secret as read: without the one line ending a file or a pipe puts after it. */
export function oneLine(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2)
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

function readFile(path: string): string {
  try {
    return readFileSync(path === '-' ? 0 : path, 'utf8')
  } catch (err) {
    fail(`cannot read ${path}: ${String(err)}`, 2)
  }
}

function label(key: string, name: string): string {
  return `${key.slice(0, 1).toUpperCase()}${key.slice(1)} for ${name}`
}

/** A line typed at the terminal; hidden, it echoes nothing. */
async function prompt(text: string, hidden: boolean): Promise<string> {
  let muted = false
  const output = new Writable({
    write(chunk: Buffer, _enc, done) {
      if (!muted) process.stderr.write(chunk)
      done()
    },
  })
  const rl = createInterface({ input: process.stdin, output, terminal: true })
  try {
    return await new Promise<string>((resolve) => {
      rl.question(`${text}: `, resolve)
      muted = hidden
    })
  } finally {
    rl.close()
    if (hidden) process.stderr.write('\n')
  }
}

/** Lines of stdin, read once when the first secret needs one. */
class StdinLines {
  private lines: string[] | null = null

  next(key: string): string {
    if (this.lines === null) {
      const text = readFile('-')
      this.lines = text === '' ? [] : text.split('\n')
      if (this.lines.at(-1) === '') this.lines.pop()
    }
    const line = this.lines.shift()
    if (line === undefined) fail(`no value on stdin for --secret ${key}`, 2)
    return oneLine(line + '\n')
  }
}

/** One sealed value: from its file, a hidden prompt in a terminal, else the next line of stdin. */
async function readSecret(
  key: string,
  path: string | null,
  name: string,
  stdin: StdinLines,
): Promise<string> {
  if (path !== null) return oneLine(readFile(path))
  if (process.stdin.isTTY) return prompt(label(key, name), true)
  return stdin.next(key)
}

/**
 * An entry from a YAML or JSON file: `name`, `type`, `fields` (or `config`, as
 * `get -o yaml` writes it) and `secrets` (or `sealed`, as `get -o yaml` writes
 * it), the sealed fields to read. An update passes `readSealed` false: it keeps
 * the sealed fields it is not given.
 */
async function loadDraft(path: string, readSealed = true): Promise<Draft> {
  const { parse } = await import('yaml')
  let data: unknown
  try {
    data = parse(readFile(path)) as unknown
  } catch (err) {
    fail(`${path} is not YAML or JSON: ${String(err)}`, 2)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    fail(`${path} must hold a mapping`, 2)
  }
  const d = data as Record<string, unknown>
  const fields = d.fields ?? d.config ?? {}
  const secrets = d.secrets ?? (readSealed ? (d.sealed ?? []) : [])
  if (typeof fields !== 'object' || Array.isArray(fields)) {
    fail(`${path}: fields must be a mapping`, 2)
  }
  if (!Array.isArray(secrets) || !secrets.every((s) => typeof s === 'string')) {
    fail(`${path}: secrets must be a list of field names`, 2)
  }
  for (const key of ['name', 'type']) {
    if (d[key] !== undefined && typeof d[key] !== 'string')
      fail(`${path}: ${key} must be a string`, 2)
  }
  return {
    ...(typeof d.name === 'string' ? { name: d.name } : {}),
    ...(typeof d.type === 'string' ? { type: d.type } : {}),
    fields: { ...(fields as Record<string, unknown>) },
    secrets: secrets.map((s) => [s, null]),
    plain: new Set(),
  }
}

/** The flags applied over a draft: `--set` then `--unset`, with `--secret` read when sent. */
function applyFlags(draft: Draft, sets: string[], secrets: string[], unsets: string[]): Draft {
  for (const word of sets) {
    const [key, value] = setValue(word)
    draft.fields[key] = value
    draft.plain.add(key)
  }
  for (const key of unsets) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete draft.fields[key]
    draft.plain.delete(key)
  }
  for (const word of secrets) draft.secrets.push(secretSource(word))
  return draft
}

function isPointer(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((k) => k === 'from' || k === 'ref' || k === 'key')
  )
}

/** Refuse a sealed field given by `--set`: it would sit in the shell's history. A pointer holds no secret. */
function refuseArgvSecrets(draft: Draft, spec: Spec): void {
  const secret = new Set(spec.filter((f) => f.secret === true).map((f) => f.name))
  for (const key of [...draft.plain].sort(compareCodePoints)) {
    if (secret.has(key) && !isPointer(draft.fields[key])) fail(NO_ARGV_SECRET(key), 2)
  }
}

/** The required fields not given, a block's only when the block is used, as the server checks them. */
export function missingRequired(spec: Spec, given: ReadonlySet<string>): string[] {
  return spec
    .filter((f) => {
      const used =
        f.group === undefined || spec.some((g) => g.group === f.group && given.has(g.name))
      return f.required === true && used && !given.has(f.name)
    })
    .map((f) => f.name)
}

async function typeFields(client: DaemonClient, kind: Kind, type: string): Promise<Spec> {
  const types = (await handleResponse(
    await client.request('GET', `${kind.route}/types`),
  )) as Record<string, Spec>
  const spec = types[type]
  if (spec === undefined) fail(`type must be a ${kind.name}: ${Object.keys(types).join(', ')}`, 2)
  return spec
}

/**
 * Read the sealed values, then the required fields still missing: prompted
 * for in a terminal, else refused, all named at once.
 */
async function fill(draft: Draft, name: string, spec: Spec): Promise<void> {
  const stdin = new StdinLines()
  for (const [key, path] of draft.secrets)
    draft.fields[key] = await readSecret(key, path, name, stdin)
  const given = new Set(
    Object.entries(draft.fields)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k]) => k),
  )
  const missing = missingRequired(spec, given)
  if (missing.length === 0) return
  if (!process.stdin.isTTY) fail(`missing required fields: ${missing.join(', ')}`, 2)
  const secret = new Set(spec.filter((f) => f.secret === true).map((f) => f.name))
  for (const key of missing) draft.fields[key] = await prompt(label(key, name), secret.has(key))
}

async function render(
  obj: unknown,
  output: string | undefined,
  human: (o: never) => string,
): Promise<void> {
  if (output === undefined) {
    emit(obj, human as (o: unknown) => string)
  } else if (output === 'yaml') {
    const { stringify } = await import('yaml')
    process.stdout.write(stringify(obj))
  } else if (output === 'json') {
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n')
  } else {
    fail(`-o takes ${OUTPUTS.join(' or ')}, not ${output}`, 2)
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value))

function formatEntry(entry: {
  name: string
  type: string
  config?: Record<string, unknown>
  sealed?: string[]
}): string {
  return [
    `name: ${entry.name}`,
    `type: ${entry.type}`,
    ...Object.entries(entry.config ?? {}).map(([k, v]) => `${k}: ${text(v)}`),
    ...(entry.sealed ?? []).map((k) => `${k}: (sealed)`),
  ].join('\n')
}

function formatEntries(listing: {
  items?: { name: string; type: string; used_by?: number }[]
}): string {
  return formatTable(
    ['NAME', 'TYPE', 'USED BY'],
    (listing.items ?? []).map((i) => [i.name, i.type, String(i.used_by ?? 0)]),
  )
}

function formatFields(spec: Spec): string {
  return formatTable(
    ['FIELD', 'TYPE', 'REQUIRED', 'SECRET', 'DEFAULT'],
    spec.map((f) => [
      f.name,
      f.type,
      f.required === true ? 'yes' : '',
      f.secret === true ? 'yes' : '',
      f.default !== undefined ? text(f.default) : '',
    ]),
  )
}

function formatTypes(types: Record<string, Spec>): string {
  return formatTable(
    ['TYPE', 'REQUIRED', 'SECRET'],
    Object.entries(types).map(([name, spec]) => [
      name,
      spec
        .filter((f) => f.required === true)
        .map((f) => f.name)
        .join(', '),
      spec
        .filter((f) => f.secret === true)
        .map((f) => f.name)
        .join(', '),
    ]),
  )
}

const collect = (value: string, previous: string[]): string[] => [...previous, value]

interface EditOptions {
  set: string[]
  secret: string[]
  unset: string[]
  file?: string
}

function editOptions(cmd: Command): Command {
  return cmd
    .option('--set <key=value>', 'A field; a value starting with { or [ is JSON.', collect, [])
    .option(
      '--secret <key>',
      'A sealed field: prompted for, read from stdin, or KEY=@FILE.',
      collect,
      [],
    )
    .option('--unset <key>', 'Remove a field.', collect, [])
    .option('-f, --file <file>', 'The entry as YAML or JSON; - for stdin.')
}

/** The commands of one kind of saved connection, one per route. */
function registerKindCommands(program: Command, kind: Kind): void {
  const group = program
    .command(kind.name)
    .description(
      `Saved ${kind.noun} connections: a type, its settings and its credentials, kept by the daemon or the hosted API.`,
    )
  const entryPath = (name: string): string => `${kind.route}/${encodeURIComponent(name)}`

  group
    .command('types')
    .description('List the types an entry can be; with TYPE, its fields.')
    .argument('[type]', "One type's fields.")
    .option('-o, --output <format>', 'json or yaml.')
    .action(async (type: string | undefined, opts: { output?: string }) => {
      const c = makeClient()
      await c.ensureRunning({ allowSpawn: false })
      if (type === undefined) {
        const types = await handleResponse(await c.request('GET', `${kind.route}/types`))
        await render(types, opts.output, formatTypes)
        return
      }
      await render(await typeFields(c, kind, type), opts.output, formatFields)
    })

  group
    .command('list')
    .description('List the saved entries, by name.')
    .option('--type <type>', 'Only TYPE.')
    .option('-q, --query <text>', 'Name has.')
    .option('-o, --output <format>', 'json or yaml.')
    .action(async (opts: { type?: string; query?: string; output?: string }) => {
      const params = new URLSearchParams()
      if (opts.type !== undefined && opts.type !== '') params.set('type', opts.type)
      if (opts.query !== undefined && opts.query !== '') params.set('q', opts.query)
      const query = params.size > 0 ? `?${params.toString()}` : ''
      const c = makeClient()
      await c.ensureRunning({ allowSpawn: false })
      await render(
        await handleResponse(await c.request('GET', `${kind.route}${query}`)),
        opts.output,
        formatEntries,
      )
    })

  group
    .command('get')
    .description('Show an entry; a sealed field shows by name only.')
    .argument('<name>')
    .option('-o, --output <format>', 'json or yaml.')
    .action(async (name: string, opts: { output?: string }) => {
      const c = makeClient()
      await c.ensureRunning({ allowSpawn: false })
      await render(
        await handleResponse(await c.request('GET', entryPath(name))),
        opts.output,
        formatEntry,
      )
    })

  editOptions(
    group
      .command('create')
      .description('Save a new entry.')
      .argument('[name]', "The entry's name.")
      .option('--type <type>', 'Its type.'),
  ).action(async (name: string | undefined, opts: EditOptions & { type?: string }) => {
    let draft = opts.file !== undefined ? await loadDraft(opts.file) : emptyDraft()
    draft = applyFlags(draft, opts.set, opts.secret, opts.unset)
    const entry = name ?? draft.name
    const type = opts.type ?? draft.type
    if (entry === undefined || entry === '')
      fail(`name the entry: mirage ${kind.name} create NAME`, 2)
    if (type === undefined || type === '') fail('give its type with --type', 2)
    const c = makeClient()
    await c.ensureRunning({ allowSpawn: true })
    const spec = await typeFields(c, kind, type)
    refuseArgvSecrets(draft, spec)
    await fill(draft, entry, spec)
    const r = await c.request('POST', kind.route, {
      body: JSON.stringify({ name: entry, type, fields: draft.fields }),
    })
    emit(await handleResponse(r), (e) => `Saved ${kind.noun} ${(e as { name: string }).name}.`)
  })

  editOptions(
    group
      .command('update')
      .description(
        'Change an entry. Plain fields not named keep their values, as do sealed ones; --unset removes either.',
      )
      .argument('<name>', "The entry's name."),
  ).action(async (name: string, opts: EditOptions) => {
    const c = makeClient()
    await c.ensureRunning({ allowSpawn: false })
    const current = (await handleResponse(await c.request('GET', entryPath(name)))) as {
      type: string
      config?: Record<string, unknown>
      sealed?: string[]
    }
    let draft = opts.file !== undefined ? await loadDraft(opts.file, false) : emptyDraft()
    draft.fields = { ...(current.config ?? {}), ...draft.fields }
    const sealed = new Set(current.sealed ?? [])
    draft = applyFlags(draft, opts.set, opts.secret, opts.unset)
    for (const key of opts.unset) if (sealed.has(key)) draft.fields[key] = null
    const spec = await typeFields(c, kind, current.type)
    refuseArgvSecrets(draft, spec)
    const stdin = new StdinLines()
    for (const [key, path] of draft.secrets)
      draft.fields[key] = await readSecret(key, path, name, stdin)
    const r = await c.request('PUT', entryPath(name), {
      body: JSON.stringify({ fields: draft.fields }),
    })
    emit(await handleResponse(r), (e) => `Updated ${kind.noun} ${(e as { name: string }).name}.`)
  })

  group
    .command('delete')
    .description(
      'Delete an entry and wipe its sealed values; there is no restore. Refused while a saved template uses it.',
    )
    .argument('<name>')
    .action(async (name: string) => {
      const c = makeClient()
      await c.ensureRunning({ allowSpawn: false })
      await handleResponse(await c.request('DELETE', entryPath(name)))
      process.stdout.write(`Deleted ${kind.noun} ${name}.\n`)
    })
}

/** `mirage vfs|cli|runtime`, the saved connections, as the HTTP routes name them. */
export function registerConnectionCommands(program: Command): void {
  for (const kind of KINDS) registerKindCommands(program, kind)
}
