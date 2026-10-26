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

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { INTRO } from '@struktoai/mirage-core/workspace/documentation/constants'
import { MountMode, Workspace, buildVfs, knownVfsNames } from '@struktoai/mirage-node'

import { type ConfigShape, configShapes, fieldDoc, moduleFile, parse } from './vfs_facts.ts'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const PACKAGES = resolve(ROOT, 'typescript', 'packages')
const DOCS = resolve(ROOT, 'docs', 'typescript')
const SECRET_NOTE = 'Fields marked secret are redacted in snapshots.'
const MIB = 1024 * 1024
const MARKER =
  /^\{\/\* generated: (?<kind>[a-z-]+) (?<key>[\w/.-]+)(?: omit=(?<omit>[\w,]+))? start \*\/\}\n(?<body>[\s\S]*?)^\{\/\* generated: \k<kind> \k<key> end \*\/\}$/gm
const TOKEN = /\{\/\* generated: ([a-z-]+) ([\w/.-]+)(?: omit=[\w,]+)? (start|end) \*\/\}/g
const CODE_SPAN = /(`+)(.+?)\1/g
const FRONTMATTER = /^---\n[\s\S]*?\n---\n+/
const FENCE = /^`{3,}/
const NOT_ADAPTERS = new Set(['browser', 'cli', 'core', 'node', 'server'])
// The path a docs page mounts its VFS at: a mount goes wherever its
// workspace puts it.
const PLACEHOLDER = '/<path>'
// A config each VFS builds from where a placeholder per required field is
// not one it accepts. Nothing is reached: building a VFS opens no
// connection. Mirrors scripts/gen_doc_tables.py.
const SAMPLES: Record<string, Record<string, string | string[]>> = {
  box: { access_token: 'token' },
  databricks_volume: {
    host: 'https://example.cloud.databricks.com',
    token: 'token',
    catalog: 'main',
    schema: 'default',
    volume: 'files',
  },
  disk: { root: '/' },
  gcal: { access_token: 'token' },
  gdocs: { access_token: 'token' },
  gdrive: { access_token: 'token' },
  github: { token: 'token', owner: 'owner', repo: 'repo' },
  gmail: { access_token: 'token' },
  gsheets: { access_token: 'token' },
  gslides: { access_token: 'token' },
  hf_buckets: { bucket: 'owner/bucket' },
  mem0: { api_key: 'key', user_id: 'user' },
  r2: { bucket: 'bucket', account_id: 'account' },
  supabase: { bucket: 'bucket', region: 'us-east-1', project_ref: 'ref' },
  tidb_filesystem: { host: 'https://aws-us-east-1.drive9.ai', token: 'token' },
  wandb: { entities: ['entity'] },
}
// GitHubVFS.create reads the repository it mounts, so a GitHub mount has
// no document without the network.
const ONLINE = new Set(['github'])

// Which feature needs each optional peer. Every optional peer of core and
// node must appear exactly once; the generator refuses a peer missing here
// or a package listed here that is no longer an optional peer.
const PEER_FEATURES: readonly { feature: string; packages: readonly string[]; needs: string }[] = [
  {
    feature: 'FUSE',
    packages: ['@zkochan/fuse-native'],
    needs:
      'Mounting a workspace as an OS filesystem; see the [FUSE setup](/typescript/setup/fuse).',
  },
  {
    feature: 'Redis',
    packages: ['redis'],
    needs:
      '`RedisVFS`, the Redis file and index cache stores, and the Redis session and history stores.',
  },
  { feature: 'Postgres', packages: ['pg'], needs: '`PostgresVFS`.' },
  { feature: 'MongoDB', packages: ['mongodb'], needs: '`MongoDBVFS` and `GridFSVFS`.' },
  { feature: 'LanceDB', packages: ['@lancedb/lancedb'], needs: '`LanceDBVFS`.' },
  { feature: 'Qdrant', packages: ['@qdrant/js-client-rest'], needs: '`QdrantVFS`.' },
  { feature: 'Chroma', packages: ['chromadb'], needs: '`ChromaVFS`.' },
  {
    feature: 'SSH',
    packages: ['ssh2'],
    needs: '`SSHVFS`, the SSH sandbox runtime and the SFTP mount.',
  },
  {
    feature: 'Email',
    packages: ['imapflow', 'mailparser', 'nodemailer'],
    needs: '`EmailVFS` (IMAP read, MIME parsing) and sending mail with `himalaya` (SMTP).',
  },
  { feature: 'OpenDAL', packages: ['opendal'], needs: '`HfBucketsVFS` and `NextcloudVFS`.' },
  {
    feature: 'Python runtimes',
    packages: ['pyodide', '@pydantic/monty'],
    needs: 'The Pyodide and Monty runtimes behind `python3`.',
  },
  {
    feature: 'JavaScript runtime',
    packages: ['quickjs-emscripten'],
    needs: 'The QuickJS runtime behind `js` and `node`.',
  },
  {
    feature: 'Sandboxes',
    packages: ['e2b', '@daytonaio/sdk'],
    needs: 'The E2B and Daytona sandbox runtimes.',
  },
  { feature: '1Password', packages: ['@1password/sdk'], needs: 'The `1password` secret source.' },
]

interface Rendered {
  body: string
  bare: string[]
  unknown: string[]
}
type Renderer = (omit: ReadonlySet<string>) => Rendered
type Renderers = Map<string, Map<string, Renderer>>

// A field or symbol name that the table never breaks mid-token.
function nameCell(name: string): string {
  return `<code style={{ whiteSpace: 'nowrap' }}>${name}</code>`
}

// A default as written in the schema; a constant product such as
// `10 * 1024 * 1024` is shown as its value, with MiB when it is whole.
function defaultText(text: string): string {
  if (!/^[\d_\s*]+$/.test(text)) return `default \`${text.replaceAll('|', '\\|')}\``
  const value = text
    .split('*')
    .map((part) => Number(part.trim().replaceAll('_', '')))
    .reduce((a, b) => a * b, 1)
  const mib = value >= MIB && value % MIB === 0 ? ` (${String(value / MIB)} MiB)` : ''
  return `default \`${String(value)}\`${mib}`
}

function escapeProse(text: string): string {
  return text
    .replaceAll('|', '\\|')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('{', '&#123;')
    .replaceAll('}', '&#125;')
}

// Prose for one Markdown table cell in MDX. Code spans keep their text,
// since MDX shows an entity inside one literally.
function cell(text: string): string {
  const flat = text.split(/\s+/).filter(Boolean).join(' ')
  let out = ''
  let last = 0
  for (const match of flat.matchAll(CODE_SPAN)) {
    out += escapeProse(flat.slice(last, match.index)) + match[0].replaceAll('|', '\\|')
    last = match.index + match[0].length
  }
  return out + escapeProse(flat.slice(last))
}

// Two columns: the name cell carries whether the field is required, its
// default and whether it is secret, so the description gets the width.
// `omit` drops fields the page's mount ignores.
function configTable(shape: ConfigShape, omit: ReadonlySet<string>): Rendered {
  const rows = ['| Field | Description |', '| --- | --- |']
  const bare: string[] = []
  let showsSecret = false
  for (const [name, field] of Object.entries(shape.fields)) {
    if (omit.has(name)) continue
    const doc = fieldDoc(field, PACKAGES)
    const description = doc.description?.trim() ?? ''
    if (description === '') bare.push(name)
    const tags = [
      ...(field.required ? ['required'] : []),
      ...(!field.required && doc.default !== undefined ? [defaultText(doc.default)] : []),
      ...(doc.secret ? ['secret'] : []),
    ]
    if (doc.secret) showsSecret = true
    const head = tags.length > 0 ? `${nameCell(name)}<br />${tags.join(', ')}` : nameCell(name)
    rows.push(`| ${head} | ${cell(description)} |`)
  }
  return {
    body: rows.join('\n') + (showsSecret ? `\n\n${SECRET_NOTE}` : ''),
    bare,
    unknown: [...omit].filter((name) => !(name in shape.fields)),
  }
}

function sameFields(a: ConfigShape | null | undefined, b: ConfigShape | null): boolean {
  if (a === undefined || a === null || b === null) return a === b
  return Object.keys(a.fields).join(',') === Object.keys(b.fields).join(',')
}

// Node's schemas under their registry names. A browser schema whose field
// set differs from node's (the presigned S3 aliases, the proxied Slack,
// Discord and Notion) gets a key of its own, `browser/<name>`.
function configRenderers(): Map<string, Renderer> {
  const node = configShapes(resolve(PACKAGES, 'node', 'src', 'vfs', 'registry.ts'), PACKAGES)
  const browser = configShapes(resolve(PACKAGES, 'browser', 'src', 'vfs', 'registry.ts'), PACKAGES)
  const out = new Map<string, Renderer>()
  for (const [name, shape] of Object.entries(node)) {
    if (shape !== null) out.set(name, (omit) => configTable(shape, omit))
  }
  for (const [name, shape] of Object.entries(browser)) {
    if (shape !== null && !sameFields(node[name], shape))
      out.set(`browser/${name}`, (omit) => configTable(shape, omit))
  }
  return out
}

interface Manifest {
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  exports?: Record<string, string | { import?: string }>
}

function manifest(pkg: string): Manifest {
  return JSON.parse(readFileSync(resolve(PACKAGES, pkg, 'package.json'), 'utf8')) as Manifest
}

function peersTable(): Rendered {
  const ranges = new Map<string, Set<string>>()
  for (const pkg of ['core', 'node']) {
    const meta = manifest(pkg)
    for (const [name, flags] of Object.entries(meta.peerDependenciesMeta ?? {})) {
      if (flags.optional !== true) continue
      const range = meta.peerDependencies?.[name]
      if (range === undefined) throw new Error(`${pkg}: optional peer ${name} declares no range`)
      ranges.set(name, (ranges.get(name) ?? new Set()).add(range))
    }
  }
  const mapped = PEER_FEATURES.flatMap((f) => f.packages)
  const unmapped = [...ranges.keys()].filter((name) => !mapped.includes(name))
  const unknown = mapped.filter((name) => !ranges.has(name))
  if (unmapped.length > 0 || unknown.length > 0 || new Set(mapped).size !== mapped.length) {
    throw new Error(
      `PEER_FEATURES disagrees with peerDependenciesMeta: unmapped ${unmapped.join(', ') || '-'}; ` +
        `not an optional peer ${unknown.join(', ') || '-'}`,
    )
  }
  const rows = ['| Feature | Packages | Needed for |', '| --- | --- | --- |']
  for (const { feature, packages, needs } of PEER_FEATURES) {
    const listed = packages
      .map((name) => `\`${name}@${[...(ranges.get(name) ?? [])].join(' + ')}\``)
      .join(', ')
    rows.push(`| ${feature} | ${listed.replaceAll('|', '\\|')} | ${needs} |`)
  }
  return { body: rows.join('\n'), bare: [], unknown: [] }
}

// The first paragraph of the `/** */` block right above a declaration.
function jsdocSummary(node: ts.Node, source: ts.SourceFile): string {
  const ranges = ts.getLeadingCommentRanges(source.text, node.getFullStart()) ?? []
  const last = ranges.at(-1)
  if (last === undefined) return ''
  const raw = source.text.slice(last.pos, last.end)
  if (!raw.startsWith('/**')) return ''
  const lines = raw
    .slice(3, -2)
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, '').trimEnd())
  const paragraph: string[] = []
  for (const line of lines) {
    if (line.startsWith('@')) break
    if (line.trim() === '') {
      if (paragraph.length > 0) break
      continue
    }
    paragraph.push(line.trim())
  }
  return paragraph.join(' ')
}

function declaredName(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .map((d) => d.name)
      .filter(ts.isIdentifier)
      .map((n) => n.text)
  }
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name !== undefined
  ) {
    return [statement.name.text]
  }
  return []
}

function isExported(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  )
}

// The names an import or a re-export binds, each with the module it names.
function bindings(statement: ts.Statement): [string, ts.ImportSpecifier | ts.ExportSpecifier][] {
  if (ts.isImportDeclaration(statement)) {
    const named = statement.importClause?.namedBindings
    if (named === undefined || !ts.isNamedImports(named)) return []
    const specifier = (statement.moduleSpecifier as ts.StringLiteral).text
    return named.elements.map((el) => [specifier, el])
  }
  if (
    ts.isExportDeclaration(statement) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.exportClause !== undefined &&
    ts.isNamedExports(statement.exportClause)
  ) {
    const specifier = statement.moduleSpecifier.text
    return statement.exportClause.elements.map((el) => [specifier, el])
  }
  return []
}

// The summary of the declaration `name` resolves to from `file`, through
// re-exports and imports, without loading the module.
function summaryOf(file: string, name: string, depth = 0): string {
  if (depth > 8) throw new Error(`${file}: ${name} does not resolve`)
  const source = parse(file)
  for (const statement of source.statements) {
    if (declaredName(statement).includes(name)) return jsdocSummary(statement, source)
  }
  for (const statement of source.statements) {
    for (const [specifier, el] of bindings(statement)) {
      if (el.name.text !== name) continue
      const target = moduleFile(file, specifier, PACKAGES)
      if (target === undefined) throw new Error(`${file}: ${specifier} does not resolve`)
      return summaryOf(target, (el.propertyName ?? el.name).text, depth + 1)
    }
  }
  throw new Error(`${file}: no declaration of ${name}`)
}

// Each module entry point of an adapter package, keyed `<pkg>` for its
// `.` export and `<pkg>/<subpath>` for the others, mapped to its source.
function entriesOf(pkg: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const [subpath, entry] of Object.entries(manifest(pkg).exports ?? {})) {
    const target = typeof entry === 'string' ? entry : entry.import
    if (target === undefined || !target.endsWith('.js')) continue
    const file = resolve(
      PACKAGES,
      pkg,
      target.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'),
    )
    if (!existsSync(file)) throw new Error(`${pkg}: ${target} has no source at ${file}`)
    out.set(subpath === '.' ? pkg : `${pkg}/${subpath.replace(/^\.\//, '')}`, file)
  }
  return out
}

function exportsOf(file: string): [string, string][] {
  const source = parse(file)
  const out: [string, string][] = []
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause
      if (clause === undefined || !ts.isNamedExports(clause))
        throw new Error(`${file}: \`export *\` hides the public names`)
      for (const el of clause.elements) {
        const target =
          statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
            ? moduleFile(file, statement.moduleSpecifier.text, PACKAGES)
            : file
        if (target === undefined) throw new Error(`${file}: an export does not resolve`)
        out.push([el.name.text, summaryOf(target, (el.propertyName ?? el.name).text)])
      }
    } else if (isExported(statement)) {
      for (const name of declaredName(statement)) out.push([name, jsdocSummary(statement, source)])
    }
  }
  return out
}

// One row per distinct summary: names documented alike, such as a family
// of constants, share a row.
function exportsTable(file: string, omit: ReadonlySet<string>): Rendered {
  const exports = exportsOf(file)
  const groups = new Map<string, string[]>()
  const bare: string[] = []
  for (const [name, text] of exports) {
    if (omit.has(name)) continue
    if (text === '') {
      bare.push(name)
      continue
    }
    groups.set(text, [...(groups.get(text) ?? []), name])
  }
  const rows = ['| Symbol | Purpose |', '| --- | --- |']
  for (const [text, names] of groups) {
    rows.push(`| ${names.map(nameCell).join('<br />')} | ${cell(text)} |`)
  }
  const known = new Set(exports.map(([name]) => name))
  return { body: rows.join('\n'), bare, unknown: [...omit].filter((name) => !known.has(name)) }
}

// `text` in a code fence longer than any fence line inside it.
function fenced(text: string, info: string): string {
  const runs = text
    .split('\n')
    .filter((line) => /^`+$/.test(line))
    .map((line) => line.length + 1)
  return `${'`'.repeat(Math.max(3, ...runs))}${info}\n${text}\n${'`'.repeat(Math.max(3, ...runs))}`
}

// A VFS.md as a docs page shows it: no frontmatter, and every heading two
// levels down, below the page's own.
function rendered(markdown: string): string {
  const lines: string[] = []
  let fence = 0
  for (let line of markdown.replace(FRONTMATTER, '').split('\n')) {
    const run = FENCE.exec(line)
    const bare = line.trim()
    if (fence === 0 && run !== null) fence = run[0].length
    else if (fence > 0 && /^`+$/.test(bare) && bare.length >= fence) fence = 0
    else if (fence === 0 && line.startsWith('#')) line = `##${line}`
    lines.push(line)
  }
  return lines.join('\n')
}

function indent(text: string): string {
  return text.replace(/^(?=.*\S)/gm, '    ')
}

// A VFS.md rendered in one tab and as its source in another.
function tabs(markdown: string): string {
  return (
    `<Tabs>\n  <Tab title="Rendered">\n${indent(rendered(markdown))}\n  </Tab>\n` +
    `  <Tab title="Raw">\n${indent(fenced(markdown, 'markdown'))}\n  </Tab>\n</Tabs>`
  )
}

// The VFS.md a workspace with each VFS mounted writable at `PLACEHOLDER`
// answers, by registry name. Rendered before the pages are, as a document
// comes back asynchronously.
async function documents(): Promise<Map<string, Renderer>> {
  const shapes = configShapes(resolve(PACKAGES, 'node', 'src', 'vfs', 'registry.ts'), PACKAGES)
  const out = new Map<string, Renderer>()
  const online = globalThis.fetch
  globalThis.fetch = () => Promise.reject(new Error('a VFS reached the network while it was built'))
  try {
    for (const name of knownVfsNames().sort(compareCodePoints)) {
      if (ONLINE.has(name)) continue
      const body = tabs(await vfsMd(name, shapes[name]?.fields ?? {}))
      out.set(name, (omit) => ({ body, bare: [], unknown: [...omit] }))
    }
  } finally {
    globalThis.fetch = online
  }
  return out
}

// One VFS's document, its trailing newline dropped.
async function vfsMd(name: string, fields: Record<string, { required: boolean }>): Promise<string> {
  const config =
    SAMPLES[name] ??
    Object.fromEntries(
      Object.entries(fields)
        .filter(([, field]) => field.required)
        .map(([field]) => [field, 'value']),
    )
  const vfs = await buildVfs(name, config)
  const ws = new Workspace({ [PLACEHOLDER]: [vfs, MountMode.WRITE] }, { mode: MountMode.WRITE })
  // The scratch root every workspace adds is no part of this VFS, and the
  // agent's opening paragraph is no part of a docs page.
  ws.mount('/').visible = () => false
  try {
    return (await ws.vfsMd()).replace(`${INTRO}\n\n`, '').replace(/\n+$/, '')
  } finally {
    await ws.close()
  }
}

function renderers(): Renderers {
  const adapters = readdirSync(PACKAGES, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !NOT_ADAPTERS.has(d.name))
    .filter((d) => existsSync(resolve(PACKAGES, d.name, 'package.json')))
    .map((d) => d.name)
    .sort(compareCodePoints)
  return new Map([
    ['config-table', configRenderers()],
    ['peers', new Map<string, Renderer>([['optional', peersTable]])],
    [
      'exports',
      new Map(
        adapters.flatMap((pkg) =>
          [...entriesOf(pkg)].map(([key, file]): [string, Renderer] => [
            key,
            (omit) => exportsTable(file, omit),
          ]),
        ),
      ),
    ],
  ])
}

function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => {
      const path = resolve(dir, d.name)
      if (d.isDirectory()) return pages(path)
      return d.name.endsWith('.mdx') ? [path] : []
    })
    .sort(compareCodePoints)
}

// Whether every marker opens or closes exactly one region, in order: a
// start with no end, an end with no start, a repeated end or two starts in
// a row would each leave rows outside every region, unchecked.
function markersPaired(text: string): boolean {
  let current: string | undefined
  let starts = 0
  for (const [, kind, key, edge] of text.matchAll(TOKEN)) {
    const marker = `${kind ?? ''} ${key ?? ''}`
    if (edge === 'start') {
      if (current !== undefined) return false
      current = marker
      starts++
    } else if (current !== marker) {
      return false
    } else {
      current = undefined
    }
  }
  return current === undefined && starts === (text.match(MARKER) ?? []).length
}

function selftest(): void {
  const start = '{/* generated: exports x start */}'
  const end = '{/* generated: exports x end */}'
  const table = '| a |\n| --- |'
  const good = `${start}\n${table}\n${end}\n`
  assert.ok(markersPaired(good))
  assert.ok(markersPaired(good.replace(' x start', ' x omit=a,b start')))
  assert.ok(markersPaired('no markers\n'))
  for (const broken of [
    `${table}\n${end}\n`,
    `${good}${end}\n`,
    `${start}\n${table}\n`,
    `${start}\n${start}\n${table}\n${end}\n`,
    `${start}\n${table}\n{/* generated: exports y end */}\n`,
    `${start} ${table} ${end}\n`,
  ]) {
    assert.ok(!markersPaired(broken), broken)
  }
  const document = '---\nname: x\n---\n\n# T\n\n```text\n# kept\n```\n\n## S'
  assert.equal(rendered(document), '### T\n\n```text\n# kept\n```\n\n#### S')
  assert.equal(tabs(document).split('    # kept').length, 3)
  console.log('gen-doc-tables selftest: ok')
}

function regenerate(
  text: string,
  page: string,
  kinds: Renderers,
  seen: Set<string>,
  errors: string[],
): string {
  if (!markersPaired(text)) {
    errors.push(
      `${page}: generated markers must pair up, each start followed by its own end on a line of its own`,
    )
  }
  return text.replace(MARKER, (whole: string, kind: string, key: string, omitted?: string) => {
    const render = kinds.get(kind)?.get(key)
    if (render === undefined) {
      errors.push(`${page}: nothing generates \`${kind} ${key}\``)
      return whole
    }
    seen.add(`${kind} ${key}`)
    const omit = new Set((omitted ?? '').split(',').filter(Boolean))
    const { body, bare, unknown } = render(omit)
    if (unknown.length > 0)
      errors.push(`${page}: \`${kind} ${key}\` omits ${unknown.join(', ')}, which it does not have`)
    if (bare.length > 0) {
      errors.push(
        `${page}: \`${kind} ${key}\` renders without a description for ${bare.join(', ')}; ` +
          'describe them in the code',
      )
    }
    const lines = whole.split('\n')
    return `${lines[0] ?? ''}\n${body}\n${lines.at(-1) ?? ''}`
  })
}

// A unified-style listing of the lines that differ, enough to see which
// rows a stale page would gain or lose.
function diff(before: string, after: string, page: string): string {
  const a = before.split('\n')
  const b = after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++
  return [
    `--- ${page}`,
    `+++ ${page} (generated)`,
    `@@ line ${String(head + 1)} @@`,
    ...a.slice(head, a.length - tail).map((line) => `-${line}`),
    ...b.slice(head, b.length - tail).map((line) => `+${line}`),
  ].join('\n')
}

async function main(): Promise<void> {
  if (process.argv.includes('--selftest')) {
    selftest()
    return
  }
  const check = process.argv.includes('--check')
  const kinds = new Map([...renderers(), ['vfs-md', await documents()]])
  const seen = new Set<string>()
  const errors: string[] = []
  const stale: string[] = []
  for (const path of pages(DOCS)) {
    const page = relative(ROOT, path)
    const text = readFileSync(path, 'utf8')
    if (!text.includes('{/* generated:')) continue
    const updated = regenerate(text, page, kinds, seen, errors)
    if (updated === text) continue
    stale.push(page)
    if (check) console.log(diff(text, updated, page))
    else writeFileSync(path, updated)
  }
  for (const [kind, keys] of kinds) {
    for (const key of [...keys.keys()].sort(compareCodePoints)) {
      if (!seen.has(`${kind} ${key}`))
        console.log(`note: no page in docs/typescript carries \`${kind} ${key}\``)
    }
  }
  if (errors.length > 0) {
    console.error(errors.join('\n'))
    process.exit(1)
  }
  if (check && stale.length > 0) {
    console.error(
      'Stale doc tables; run node --experimental-strip-types typescript/scripts/gen-doc-tables.ts:\n' +
        stale.join('\n'),
    )
    process.exit(1)
  }
  console.log(`doc tables ${check ? 'checked' : 'generated'}: ${String(seen.size)} regions`)
}

await main()
