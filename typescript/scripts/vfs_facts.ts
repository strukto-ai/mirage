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

import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import ts from 'typescript'

import { ListingVersion } from '@struktoai/mirage-core'

// Capability values and the functions a class defines are read from the
// source rather than from a live object on purpose. Python can introspect
// its VFS classes because the values are class attributes, but the
// typescript twins are instance fields, so the only way to observe them
// at runtime is to construct the VFS — and construction is not inert
// here: `buildVfs('github', {})` issues an HTTP request and `postgres`
// opens a connection. A generator that reaches the network produces a
// different spec depending on who runs it, so the values come from the
// declarations instead.

// What a declaration slot can be read as: a numeric or boolean literal,
// null, or a string -- which covers both a named constant reported by its
// name and a slot declared with no initializer at all.
type CapabilityValue = number | boolean | string | null

const CAPABILITY_FIELDS = [
  'indexTtl',
  'cachesReads',
  'readRevalidatable',
  'supportsSnapshot',
  'sizesAlwaysKnown',
  'listingVersion',
  'readsRanges',
  'local',
  'maxGlobMatches',
  'maxDuEntries',
] as const

// The functions a backend may define, as BaseVFS declares them. Which ones
// a class overrides decides what its mount and its commands can do.
const VFS_FUNCTIONS = new Set([
  'readdir',
  'read',
  'stat',
  'readStream',
  'exists',
  'find',
  'duSize',
  'duEntries',
  'write',
  'append',
  'pwrite',
  'create',
  'mkdir',
  'unlink',
  'rmdir',
  'rmR',
  'rename',
  'copy',
  'dirCopy',
  'truncate',
  'setattr',
  'search',
  'searchMany',
  'narrowPaths',
  'contentSearchEnabled',
  'isMounted',
])

const BASE_CLASS = 'BaseVFS'

export interface Capabilities {
  index_ttl: number | string
  caches_reads: boolean | string
  read_revalidatable: boolean | string
  supports_snapshot: boolean | string
  sizes_always_known: boolean | string
  listing_version: string
  storage_location: boolean
  capacity: boolean
  has_prompt: boolean
  has_write_prompt: boolean
  functions: string[]
  reads_ranges: boolean | string
  local: boolean | string
  max_glob_matches: number | string | null
  max_du_entries: number | string | null
}

interface ClassInfo {
  decl: ts.ClassDeclaration
  source: ts.SourceFile
  parent: string | undefined
}

function snake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, ts.sys.readFile(file) ?? '', ts.ScriptTarget.ESNext, true)
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(path)
  }
  return out
}

// The literal a capability field is initialized with. Anything computed
// is reported verbatim as `<expr:Kind>` so the parity gate shows a real
// mismatch instead of a plausible-looking default: a value this cannot
// read is a value it must not guess.
function literalValue(node: ts.Expression | undefined): CapabilityValue {
  if (node === undefined) return '<declared, no initializer>'
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll('_', ''))
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    const value = Number(node.operand.text.replaceAll('_', ''))
    return node.operator === ts.SyntaxKind.MinusToken ? -value : value
  }
  // `ListingVersion.MOUNT` reads as its wire value, the string python's
  // StrEnum dumps; a member the enum lacks falls through to the marker.
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'ListingVersion' &&
    Object.hasOwn(ListingVersion, node.name.text)
  ) {
    return ListingVersion[node.name.text as keyof typeof ListingVersion]
  }
  return `<expr:${ts.SyntaxKind[node.kind]}>`
}

function heritageName(decl: ts.ClassDeclaration): string | undefined {
  for (const clause of decl.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue
    const expr = clause.types[0]?.expression
    if (expr !== undefined && ts.isIdentifier(expr)) return expr.text
  }
  return undefined
}

/**
 * Every registry name's capability values for one variant, read from the
 * class the entry constructs; null for a name whose entry builds none. A
 * name whose class cannot be resolved is a hard error: a missing row would
 * read as "no divergence here" in the parity gate. `scripts/gen-specs.ts`
 * dumps this, and the capability tests read it live.
 *
 * Args:
 *   packagesRoot: absolute path to `typescript/packages`.
 *   pkgs: the packages the variant scans, its own package last.
 */
export function registryCapabilities(
  packagesRoot: string,
  pkgs: readonly string[],
): Record<string, Capabilities | null> {
  const classes = collectClasses(packagesRoot, pkgs)
  const variant = pkgs[pkgs.length - 1] as string
  const names = registryClasses(resolve(packagesRoot, variant, 'src', 'vfs', 'registry.ts'))
  const out: Record<string, Capabilities | null> = {}
  for (const [vfs, className] of names) {
    out[vfs] = className === null ? null : capabilitiesOf(className, classes)
  }
  return out
}

/**
 * Every VFS class a variant can reach, keyed by class name.
 *
 * Duplicate names across the scanned packages would make the extends walk
 * ambiguous, so they are refused rather than resolved by import order.
 */
export function collectClasses(
  packagesRoot: string,
  pkgs: readonly string[],
): Map<string, ClassInfo> {
  const out = new Map<string, ClassInfo>()
  for (const pkg of pkgs) {
    for (const file of sourceFiles(resolve(packagesRoot, pkg, 'src', 'vfs'))) {
      const source = parse(file)
      ts.forEachChild(source, (node) => {
        if (!ts.isClassDeclaration(node) || node.name === undefined) return
        const name = node.name.text
        const seen = out.get(name)
        if (seen !== undefined) {
          throw new Error(
            `two VFS classes named ${name}: ${seen.source.fileName} and ${file}; ` +
              `the capability walk cannot tell which one a registry entry means`,
          )
        }
        out.set(name, { decl: node, source, parent: heritageName(node) })
      })
    }
  }
  return out
}

function chain(className: string, classes: Map<string, ClassInfo>): ClassInfo[] {
  const out: ClassInfo[] = []
  const seen = new Set<string>()
  let name: string | undefined = className
  while (name !== undefined && !seen.has(name)) {
    seen.add(name)
    const info: ClassInfo | undefined = classes.get(name)
    if (info === undefined) break
    out.push(info)
    name = info.parent
  }
  return out
}

function declaresMethod(info: ClassInfo, name: string): boolean {
  return info.decl.members.some(
    (m) =>
      (ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m)) &&
      m.name.getText(info.source) === name,
  )
}

function isEmptyString(node: ts.Expression): boolean {
  return ts.isStringLiteralLike(node) && node.text === ''
}

// Whether the class's constructor assigns `this.<name>` a value other than
// the empty string. A prompt that embeds the mount prefix is built there
// (postgres, mongodb), so its field is declared with no initializer.
function assignsInConstructor(info: ClassInfo, name: string): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.left.name.text === name &&
      !isEmptyString(node.right)
    ) {
      found = true
    }
    ts.forEachChild(node, visit)
  }
  for (const member of info.decl.members) {
    if (ts.isConstructorDeclaration(member) && member.body !== undefined) visit(member.body)
  }
  return found
}

/**
 * Whether a class on the extends chain gives a text slot a value.
 *
 * The nearest declaration decides, as it does at runtime: an initializer
 * other than `''`, a getter, or a bare declaration its constructor fills.
 * `BaseVFS` declares both slots without a value: its constructor only
 * forwards what a table-built driver passes in, which no static read can
 * see, so reaching the base means the class gives none. `buildFilePrompt`
 * skips a mount whose prompt is absent, so a class that gives neither
 * describes nothing to an agent.
 *
 * Args:
 *   ancestry: the class and its ancestors, nearest first.
 *   name: the instance field to read.
 */
function givesText(ancestry: readonly ClassInfo[], name: string): boolean {
  for (const info of ancestry) {
    if (info.decl.name?.text === BASE_CLASS) return false
    for (const member of info.decl.members) {
      if (member.name?.getText(info.source) !== name) continue
      if (ts.isGetAccessorDeclaration(member)) return true
      if (!ts.isPropertyDeclaration(member)) continue
      if (member.initializer !== undefined) return !isEmptyString(member.initializer)
      return assignsInConstructor(info, name)
    }
  }
  return false
}

/**
 * One class's capability values, resolved up its extends chain.
 *
 * The three boolean capabilities default to false on `BaseVFS`, as
 * `indexTtl` defaults to 600, and the walk reads the nearest
 * declaration up the chain, so a class that declares none of them
 * reports the base's false.
 *
 * Args:
 *   className: the class the registry constructs.
 *   classes: every reachable VFS class, from `collectClasses`.
 */
export function capabilitiesOf(className: string, classes: Map<string, ClassInfo>): Capabilities {
  const ancestry = chain(className, classes)
  if (ancestry.length === 0) throw new Error(`no source declaration for VFS class ${className}`)
  const values: Record<string, CapabilityValue> = {}
  for (const info of ancestry) {
    for (const member of info.decl.members) {
      if (!ts.isPropertyDeclaration(member)) continue
      const name = member.name.getText(info.source)
      if (!(CAPABILITY_FIELDS as readonly string[]).includes(name)) continue
      if (name in values) continue
      const init = member.initializer
      const value = literalValue(init)
      values[name] =
        init !== undefined && ts.isIdentifier(init) && typeof value === 'string'
          ? (resolveIdentifier(info.source, init.text) ?? value)
          : value
    }
  }
  const overrides = ancestry.filter((info) => info.decl.name?.text !== BASE_CLASS)
  const functions = new Set<string>()
  for (const info of overrides) {
    for (const member of info.decl.members) {
      if (!ts.isMethodDeclaration(member)) continue
      if (member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) === true) continue
      const name = member.name.getText(info.source)
      if (VFS_FUNCTIONS.has(name)) functions.add(snake(name))
    }
  }
  return {
    index_ttl: numericCapability(values, 'indexTtl', 600, className),
    caches_reads: booleanCapability(values, 'cachesReads', false, className),
    read_revalidatable: booleanCapability(values, 'readRevalidatable', false, className),
    supports_snapshot: booleanCapability(values, 'supportsSnapshot', false, className),
    sizes_always_known: booleanCapability(values, 'sizesAlwaysKnown', false, className),
    listing_version: stringCapability(values, 'listingVersion', className),
    storage_location: overrides.some((info) => declaresMethod(info, 'storageLocation')),
    capacity: overrides.some((info) => declaresMethod(info, 'capacity')),
    has_prompt: givesText(ancestry, 'prompt'),
    has_write_prompt: givesText(ancestry, 'writePrompt'),
    functions: [...functions].sort(compareCodePoints),
    reads_ranges: booleanCapability(values, 'readsRanges', false, className),
    local: booleanCapability(values, 'local', false, className),
    max_glob_matches: nullableNumber(values, 'maxGlobMatches', className),
    max_du_entries: nullableNumber(values, 'maxDuEntries', className),
  }
}

// A capability slot holds a literal, a named constant reported by its name,
// or the placeholder for a slot declared without an initializer -- so a
// string is always a legal reading, and only a number where a boolean belongs
// (or the reverse) is wrong. Refuse it here rather than emit it: a miscoerced
// value surfaces downstream as an unexplained `check_spec_parity.py` mismatch
// against Python, where nothing names the class that declared it.
function numericCapability(
  values: Record<string, CapabilityValue>,
  name: string,
  fallback: number,
  className: string,
): number | string {
  const value = values[name]
  if (value === undefined) return fallback
  if (typeof value === 'boolean' || value === null) {
    throw new Error(`${className}.${name} is ${String(value)}, expected a number`)
  }
  return value
}

// A cap BaseVFS declares with a default, so every chain reaches a value;
// null means no cap.
function nullableNumber(
  values: Record<string, CapabilityValue>,
  name: string,
  className: string,
): number | string | null {
  const value = values[name]
  if (value === undefined || typeof value === 'boolean') {
    throw new Error(`${className}.${name} is ${String(value)}, expected a number or null`)
  }
  return value
}

function booleanCapability(
  values: Record<string, CapabilityValue>,
  name: string,
  fallback: boolean,
  className: string,
): boolean | string {
  const value = values[name]
  if (value === undefined) return fallback
  if (typeof value === 'number' || value === null) {
    throw new Error(`${className}.${name} is ${String(value)}, expected a boolean`)
  }
  return value
}

// A slot with no default of its own: BaseVFS declares it, so every chain
// reaches a value, and anything but a string is a misread.
function stringCapability(
  values: Record<string, CapabilityValue>,
  name: string,
  className: string,
): string {
  const value = values[name]
  if (typeof value !== 'string') {
    throw new Error(`${className}.${name} is ${String(value)}, expected a string`)
  }
  return value
}

// The value of a named constant a slot was set to, followed one import
// hop. `maxGlobMatches: SCOPE_ERROR` is the whole reason this exists:
// reporting the name instead of 5000 would make the two languages differ
// on a value they agree about.
function resolveIdentifier(source: ts.SourceFile, name: string): CapabilityValue | undefined {
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name)
          return literalValue(decl.initializer)
      }
    }
    if (!ts.isImportDeclaration(statement)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    if (!bindings.elements.some((el) => el.name.text === name)) continue
    const specifier = (statement.moduleSpecifier as ts.StringLiteral).text
    if (!specifier.startsWith('.')) continue
    const target = resolve(source.fileName, '..', specifier)
    if (!existsSync(target)) continue
    for (const inner of parse(target).statements) {
      if (!ts.isVariableStatement(inner)) continue
      for (const decl of inner.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name)
          return literalValue(decl.initializer)
      }
    }
  }
  return undefined
}

// Whether a registry factory exists only to explain that this runtime
// cannot serve the backend: it throws, or hands back a rejected promise,
// without constructing anything.
function refuses(node: ts.Node): boolean {
  let found = false
  const scan = (child: ts.Node): void => {
    if (ts.isThrowStatement(child)) found = true
    if (
      ts.isPropertyAccessExpression(child) &&
      child.name.text === 'reject' &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === 'Promise'
    ) {
      found = true
    }
    ts.forEachChild(child, scan)
  }
  scan(node)
  return found
}

/**
 * Registry name to the class its factory constructs.
 *
 * Read from `registry.ts` rather than guessed from directory names: the
 * S3-compatible entries and the HuggingFace variants each map several
 * names onto classes whose directories do not match, and a guess that
 * lands on the wrong class would report capabilities for a backend the
 * user never mounts.
 *
 * Args:
 *   registryFile: absolute path to the variant's `VFS/registry.ts`.
 */
export function registryClasses(registryFile: string): Map<string, string | null> {
  const source = parse(registryFile)
  const out = new Map<string, string | null>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'REGISTRY' &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const prop of node.initializer.properties) {
        if (!ts.isPropertyAssignment(prop)) continue
        const name = prop.name.getText(source).replace(/^['"]|['"]$/g, '')
        const classes = new Set<string>()
        const scan = (child: ts.Node): void => {
          if (ts.isNewExpression(child) && ts.isIdentifier(child.expression)) {
            classes.add(child.expression.text)
          }
          // `GitHubVFS.create(...)` and `DatabricksVolumeVFS
          // .create(...)` are async static factories, so the class never
          // appears under `new`.
          if (
            ts.isPropertyAccessExpression(child) &&
            child.name.text === 'create' &&
            ts.isIdentifier(child.expression) &&
            child.expression.text.endsWith('VFS')
          ) {
            classes.add(child.expression.text)
          }
          ts.forEachChild(child, scan)
        }
        scan(prop.initializer)
        const vfsClasses = [...classes].filter((c) => c.endsWith('VFS'))
        if (vfsClasses.length === 0 && refuses(prop.initializer)) {
          // Registered so the name resolves and the error explains why,
          // but there is no class to read capabilities from — the browser
          // does this for lancedb (native addon) and email (raw TCP).
          out.set(name, null)
          continue
        }
        if (vfsClasses.length !== 1) {
          throw new Error(
            `registry entry ${name} constructs ${vfsClasses.length} VFS classes ` +
              `(${vfsClasses.join(', ') || 'none'}); the capability dump needs exactly one`,
          )
        }
        out.set(name, vfsClasses[0] as string)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (out.size === 0) throw new Error(`no REGISTRY object literal found in ${registryFile}`)
  return out
}

// ---------------------------------------------------------------------------
// Config field sets: what a mount can be told.
//
// Python dumps its pydantic wire names off the model. TypeScript's twin is
// the zod schema behind each `normalize*Config` entry point, and it is read from
// the source rather than observed, for the same reason capabilities are:
// most schemas are module-private, and constructing a VFS to reach one
// is not inert. The walk follows exactly the forms the config modules use --
// a config call in the exported function, `alias.normalize` off one of the
// S3 factories, a re-exported normalizer -- and throws on any other, so a
// new form fails the dump rather than emitting a row that reads as "no
// divergence here".
// ---------------------------------------------------------------------------

export interface ConfigFacts {
  fields: Record<string, { required: boolean }>
  rename: Record<string, string>
  validates: boolean
}

const CONFIG_PARSER = 'parseConfigWithSchema'
const NORMALIZER_RE = /^normalize\w*Config$/

interface Bound {
  expr: ts.Expression
  source: ts.SourceFile
}
type Env = Map<string, Bound>

function moduleFile(fromFile: string, specifier: string, packagesRoot: string): string | undefined {
  if (specifier.startsWith('.')) {
    const file = resolve(fromFile, '..', specifier)
    return existsSync(file) ? file : undefined
  }
  const m = /^@struktoai\/mirage-(core|node|browser)\/(.+)$/.exec(specifier)
  if (m === null) return undefined
  const file = resolve(packagesRoot, m[1] as string, 'src', `${m[2] as string}.ts`)
  return existsSync(file) ? file : undefined
}

// The normalizer a registry entry calls, and the module it imports it from.
function registryNormalizers(
  registryFile: string,
  packagesRoot: string,
): Map<string, { file: string; name: string } | null> {
  const source = parse(registryFile)
  const out = new Map<string, { file: string; name: string } | null>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'REGISTRY' &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const prop of node.initializer.properties) {
        if (!ts.isPropertyAssignment(prop)) continue
        const name = prop.name.getText(source).replace(/^['"]|['"]$/g, '')
        let found: { file: string; name: string } | null = null
        const scan = (child: ts.Node): void => {
          // `const { normalizeX } = await import('...')`
          if (
            ts.isVariableDeclaration(child) &&
            ts.isObjectBindingPattern(child.name) &&
            child.initializer !== undefined &&
            ts.isAwaitExpression(child.initializer) &&
            ts.isCallExpression(child.initializer.expression) &&
            child.initializer.expression.expression.kind === ts.SyntaxKind.ImportKeyword
          ) {
            const spec = child.initializer.expression.arguments[0]
            for (const el of child.name.elements) {
              const local = el.name.getText(source)
              if (!NORMALIZER_RE.test(local) || spec === undefined || !ts.isStringLiteral(spec)) {
                continue
              }
              const file = moduleFile(registryFile, spec.text, packagesRoot)
              if (file === undefined) {
                throw new Error(
                  `registry entry ${name} imports ${spec.text}, which does not resolve`,
                )
              }
              found = { file, name: (el.propertyName ?? el.name).getText(source) }
            }
          }
          ts.forEachChild(child, scan)
        }
        scan(prop.initializer)
        out.set(name, found)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

// The file a local name was imported from, and the name it has there,
// following both relative specifiers and the `@struktoai/mirage-core/...`
// subpaths the node and browser packages use.
function importOrigin(
  source: ts.SourceFile,
  local: string,
  packagesRoot: string,
): { file: string; exported: string } | undefined {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if (element.name.text !== local) continue
      const specifier = (statement.moduleSpecifier as ts.StringLiteral).text
      const file = moduleFile(source.fileName, specifier, packagesRoot)
      if (file === undefined) return undefined
      return { file, exported: (element.propertyName ?? element.name).text }
    }
  }
  return undefined
}

function topLevelConst(source: ts.SourceFile, name: string): ts.Expression | undefined {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl.initializer
    }
  }
  return undefined
}

function topLevelFunction(
  source: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement
  }
  const init = topLevelConst(source, name)
  if (init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return init
  return undefined
}

// A re-export (`export { a as b } from './x.ts'`) naming `name`, if any.
function reExportOf(
  source: ts.SourceFile,
  name: string,
  packagesRoot: string,
): { file: string; name: string } | undefined {
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined) continue
    const clause = statement.exportClause
    if (clause === undefined || !ts.isNamedExports(clause)) continue
    for (const el of clause.elements) {
      if (el.name.text !== name) continue
      const spec = (statement.moduleSpecifier as ts.StringLiteral).text
      const file = moduleFile(source.fileName, spec, packagesRoot)
      if (file === undefined)
        throw new Error(`${source.fileName} re-exports from ${spec}, which does not resolve`)
      return { file, name: (el.propertyName ?? el.name).text }
    }
  }
  return undefined
}

// Where an identifier is declared: the enclosing env (a factory's parameter
// bound at its call site), a top-level const in this file, or the file it
// was imported from.
function bindingOf(
  name: string,
  source: ts.SourceFile,
  env: Env,
  packagesRoot: string,
): Bound | undefined {
  const bound = env.get(name)
  if (bound !== undefined) return bound
  const local = topLevelConst(source, name)
  if (local !== undefined) return { expr: local, source }
  const origin = importOrigin(source, name, packagesRoot)
  if (origin !== undefined) {
    const imported = parse(origin.file)
    const expr = topLevelConst(imported, origin.exported)
    if (expr !== undefined) return { expr, source: imported }
  }
  return undefined
}

function propertyKey(prop: ts.ObjectLiteralElementLike, source: ts.SourceFile): string | undefined {
  return prop.name?.getText(source).replace(/^['"]|['"]$/g, '')
}

const OPTIONAL_RE = /\.optional\(\)|\.default\(|\.nullish\(\)/

// The field set of a schema expression, following the forms in use.
function shapeOf(
  expr: ts.Expression,
  source: ts.SourceFile,
  env: Env,
  packagesRoot: string,
  label: string,
): Record<string, { required: boolean }> {
  if (ts.isParenthesizedExpression(expr))
    return shapeOf(expr.expression, source, env, packagesRoot, label)
  if (ts.isIdentifier(expr)) {
    const bound = bindingOf(expr.text, source, env, packagesRoot)
    if (bound === undefined)
      throw new Error(`${label}: cannot resolve schema identifier ${expr.text}`)
    return shapeOf(bound.expr, bound.source, env, packagesRoot, label)
  }
  if (ts.isObjectLiteralExpression(expr))
    return shapeOfLiteral(expr, source, env, packagesRoot, label)
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text
      if (
        method === 'object' &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'z'
      ) {
        const arg = expr.arguments[0]
        if (arg === undefined || !ts.isObjectLiteralExpression(arg)) {
          throw new Error(`${label}: z.object() without an object literal`)
        }
        return shapeOfLiteral(arg, source, env, packagesRoot, label)
      }
      if (method === 'extend' || method === 'safeExtend') {
        const base = shapeOf(callee.expression, source, env, packagesRoot, label)
        const arg = expr.arguments[0]
        if (arg === undefined || !ts.isObjectLiteralExpression(arg)) {
          throw new Error(`${label}: .${method}() without an object literal`)
        }
        return { ...base, ...shapeOfLiteral(arg, source, env, packagesRoot, label) }
      }
      // .refine / .superRefine / .strict / .describe / .meta keep the shape.
      return shapeOf(callee.expression, source, env, packagesRoot, label)
    }
    if (ts.isIdentifier(callee)) {
      // A schema-building helper such as `browserAliasSchema(extra)`: its
      // return expression, with its parameters bound to this call's
      // arguments.
      const fn = resolveFunction(callee.text, source, packagesRoot)
      if (fn === undefined) throw new Error(`${label}: cannot resolve schema helper ${callee.text}`)
      const inner: Env = new Map(env)
      fn.decl.parameters.forEach((param, i) => {
        const arg = expr.arguments[i]
        if (arg !== undefined && ts.isIdentifier(param.name)) {
          inner.set(param.name.text, { expr: arg, source })
        }
      })
      const returned = returnExpression(fn.decl)
      if (returned === undefined) throw new Error(`${label}: helper ${callee.text} has no return`)
      return shapeOf(returned, fn.source, inner, packagesRoot, label)
    }
  }
  throw new Error(`${label}: unsupported schema expression ${expr.getText(source).slice(0, 60)}`)
}

function shapeOfLiteral(
  literal: ts.ObjectLiteralExpression,
  source: ts.SourceFile,
  env: Env,
  packagesRoot: string,
  label: string,
): Record<string, { required: boolean }> {
  const out: Record<string, { required: boolean }> = {}
  for (const prop of literal.properties) {
    if (ts.isSpreadAssignment(prop)) {
      Object.assign(out, shapeOf(prop.expression, source, env, packagesRoot, label))
      continue
    }
    const key = propertyKey(prop, source)
    if (key === undefined) continue
    if (ts.isPropertyAssignment(prop)) {
      out[key] = { required: !OPTIONAL_RE.test(prop.initializer.getText(source)) }
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      const bound = bindingOf(key, source, env, packagesRoot)
      out[key] = {
        required: bound === undefined || !OPTIONAL_RE.test(bound.expr.getText(bound.source)),
      }
    }
  }
  return out
}

function resolveFunction(
  name: string,
  source: ts.SourceFile,
  packagesRoot: string,
):
  | {
      decl: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression
      source: ts.SourceFile
    }
  | undefined {
  const local = topLevelFunction(source, name)
  if (local !== undefined) return { decl: local, source }
  const origin = importOrigin(source, name, packagesRoot)
  if (origin === undefined) return undefined
  const imported = parse(origin.file)
  const decl = topLevelFunction(imported, origin.exported)
  return decl === undefined ? undefined : { decl, source: imported }
}

function returnExpression(
  fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
): ts.Expression | undefined {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return fn.body
  let found: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression !== undefined && found === undefined) {
      found = node.expression
    }
    if (!ts.isFunctionLike(node) || node === fn) ts.forEachChild(node, visit)
  }
  if (fn.body !== undefined) visit(fn.body)
  return found
}

// The `rename` map an entry point applies, resolved through any const or spread.
function renameOf(
  expr: ts.Expression | undefined,
  source: ts.SourceFile,
  env: Env,
  packagesRoot: string,
  label: string,
): Record<string, string> {
  if (expr === undefined) return {}
  if (ts.isIdentifier(expr)) {
    const bound = bindingOf(expr.text, source, env, packagesRoot)
    if (bound === undefined) throw new Error(`${label}: cannot resolve normalizer ${expr.text}`)
    return renameOf(bound.expr, bound.source, env, packagesRoot, label)
  }
  if (!ts.isObjectLiteralExpression(expr)) {
    throw new Error(
      `${label}: unsupported normalizer expression ${expr.getText(source).slice(0, 60)}`,
    )
  }
  // Either the normalizer literal (`{ rename: {...}, transform: ... }`) or,
  // one level down, the rename map itself.
  const renameProp = expr.properties.find(
    (p) => ts.isPropertyAssignment(p) && propertyKey(p, source) === 'rename',
  )
  if (renameProp !== undefined && ts.isPropertyAssignment(renameProp)) {
    return renameOf(renameProp.initializer, source, env, packagesRoot, label)
  }
  const out: Record<string, string> = {}
  for (const prop of expr.properties) {
    if (ts.isSpreadAssignment(prop)) {
      Object.assign(out, renameOf(prop.expression, source, env, packagesRoot, label))
      continue
    }
    const key = propertyKey(prop, source)
    if (key === undefined || !ts.isPropertyAssignment(prop)) continue
    if (ts.isStringLiteral(prop.initializer)) out[key] = prop.initializer.text
  }
  return out
}

// The `parseConfigWithSchema(schema, input, normalizer?)` call inside a body.
function configCall(body: ts.Node): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined
  const visit = (node: ts.Node): void => {
    if (
      found === undefined &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === CONFIG_PARSER
    ) {
      found = node
    }
    ts.forEachChild(node, visit)
  }
  visit(body)
  return found
}

function factsOfConfigCall(
  call: ts.CallExpression,
  source: ts.SourceFile,
  env: Env,
  packagesRoot: string,
  label: string,
): ConfigFacts {
  const schema = call.arguments[0]
  if (schema === undefined) throw new Error(`${label}: ${CONFIG_PARSER} without a schema`)
  return {
    fields: shapeOf(schema, source, env, packagesRoot, label),
    rename: renameOf(call.arguments[2], source, env, packagesRoot, label),
    validates: true,
  }
}

// The facts behind one exported normalizer.
function factsOfNormalizer(
  file: string,
  name: string,
  packagesRoot: string,
  label: string,
  depth = 0,
): ConfigFacts {
  if (depth > 6) throw new Error(`${label}: normalizer resolution did not converge at ${name}`)
  const source = parse(file)
  const reExport = reExportOf(source, name, packagesRoot)
  if (reExport !== undefined)
    return factsOfNormalizer(reExport.file, reExport.name, packagesRoot, label, depth + 1)
  const fn = topLevelFunction(source, name)
  if (fn !== undefined) {
    const call = fn.body === undefined ? undefined : configCall(fn.body)
    if (call === undefined) return { fields: {}, rename: {}, validates: false }
    return factsOfConfigCall(call, source, new Map(), packagesRoot, label)
  }
  const init = topLevelConst(source, name)
  if (init === undefined) {
    const origin = importOrigin(source, name, packagesRoot)
    if (origin !== undefined)
      return factsOfNormalizer(origin.file, origin.exported, packagesRoot, label, depth + 1)
    throw new Error(`${label}: no declaration of ${name} in ${file}`)
  }
  // `export const normalizeX = normalizeY`
  if (ts.isIdentifier(init)) {
    const origin = importOrigin(source, init.text, packagesRoot)
    if (origin !== undefined)
      return factsOfNormalizer(origin.file, origin.exported, packagesRoot, label, depth + 1)
    return factsOfNormalizer(file, init.text, packagesRoot, label, depth + 1)
  }
  // `export const normalizeX = alias.normalize`, `alias = makeSomething(...)`
  if (ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.expression)) {
    const aliasInit = topLevelConst(source, init.expression.text)
    if (
      aliasInit === undefined ||
      !ts.isCallExpression(aliasInit) ||
      !ts.isIdentifier(aliasInit.expression)
    ) {
      throw new Error(`${label}: ${init.expression.text} is not a factory call`)
    }
    const factory = resolveFunction(aliasInit.expression.text, source, packagesRoot)
    if (factory === undefined)
      throw new Error(`${label}: cannot resolve factory ${aliasInit.expression.text}`)
    // Bind the factory's parameters to the call site: a positional
    // parameter by name, and every property of an options object.
    const env: Env = new Map()
    factory.decl.parameters.forEach((param, i) => {
      const arg = aliasInit.arguments[i]
      if (arg === undefined) return
      if (ts.isIdentifier(param.name)) env.set(param.name.text, { expr: arg, source })
      if (ts.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) {
          const key = propertyKey(prop, source)
          if (key !== undefined && ts.isPropertyAssignment(prop))
            env.set(key, { expr: prop.initializer, source })
          if (key !== undefined && ts.isShorthandPropertyAssignment(prop))
            env.set(key, { expr: prop.name, source })
        }
      }
    })
    const body = factory.decl.body
    const call = body === undefined ? undefined : configCall(body)
    if (call === undefined) return { fields: {}, rename: {}, validates: false }
    return factsOfConfigCall(call, factory.source, env, packagesRoot, label)
  }
  throw new Error(
    `${label}: unsupported normalizer declaration ${init.getText(source).slice(0, 60)}`,
  )
}

/**
 * Per registry name, the config field set behind its normalizer.
 *
 * Args:
 *   registryFile: absolute path to the variant's `VFS/registry.ts`.
 *   packagesRoot: absolute path to `typescript/packages`.
 *
 * A name whose factory calls no `normalize*Config` (ram, disk, redis take
 * raw kwargs, as their python twins do) dumps null.
 */
// Codepoint compare, not `localeCompare` and not the default comparator:
// python's `sorted` and `json.dumps(sort_keys=True)` order by code point,
// so `scripts/gen_specs.py` and this generator must use the same rule or
// the two spec trees a human diffs carry ordering noise on top of real
// drift. `localeCompare` with no locale argument also reads the runtime's
// ICU data, which makes pre-commit's Spec drift step machine-dependent.
// Inlined rather than imported from `@struktoai/mirage-core/utils/sort`
// because a script runs before any package is built.
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const aPoint = a.codePointAt(i) ?? 0
    const bPoint = b.codePointAt(j) ?? 0
    if (aPoint !== bPoint) return aPoint - bPoint
    i += aPoint > 0xffff ? 2 : 1
    j += bPoint > 0xffff ? 2 : 1
  }
  return a.length - i - (b.length - j)
}

export function configFacts(
  registryFile: string,
  packagesRoot: string,
): Record<string, ConfigFacts | null> {
  const out: Record<string, ConfigFacts | null> = {}
  const entries = registryNormalizers(registryFile, packagesRoot)
  for (const [vfs, normalizer] of [...entries].sort(([a], [b]) => compareCodePoints(a, b))) {
    out[vfs] =
      normalizer === null
        ? null
        : factsOfNormalizer(normalizer.file, normalizer.name, packagesRoot, `configs[${vfs}]`)
  }
  return out
}
