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

// Capability values and CommandIO slots are read from the source rather
// than from a live object on purpose. Python can introspect its resource
// classes because the values are class attributes, but the typescript
// twins are instance fields, so the only way to observe them at runtime
// is to construct the resource — and construction is not inert here:
// `buildResource('github', {})` issues an HTTP request and `postgres`
// opens a connection. A generator that reaches the network produces a
// different spec depending on who runs it, so the values come from the
// declarations instead.

const CAPABILITY_FIELDS = [
  'indexTtl',
  'cachesReads',
  'supportsSnapshot',
  'sizesAlwaysKnown',
] as const

// Slots that carry a configuration value rather than an operation. They
// are reported as values; every other key of the literal is a wired slot.
const IO_VALUE_FIELDS = new Set(['local', 'maxGlobMatches', 'maxDuEntries'])

const BASE_CLASS = 'BaseResource'

export interface Capabilities {
  index_ttl: number | string
  caches_reads: boolean | string
  supports_snapshot: boolean | string
  sizes_always_known: boolean | string
  storage_id: boolean
  statfs: boolean
}

export interface CommandIoFacts {
  slots: string[]
  local: boolean
  max_glob_matches: number | null
  max_du_entries: number | null
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
function literalValue(node: ts.Expression | undefined): number | boolean | string {
  if (node === undefined) return '<declared, no initializer>'
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll('_', ''))
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    const value = Number(node.operand.text.replaceAll('_', ''))
    return node.operator === ts.SyntaxKind.MinusToken ? -value : value
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
 * Every resource class a variant can reach, keyed by class name.
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
    for (const file of sourceFiles(resolve(packagesRoot, pkg, 'src', 'resource'))) {
      const source = parse(file)
      ts.forEachChild(source, (node) => {
        if (!ts.isClassDeclaration(node) || node.name === undefined) return
        const name = node.name.text
        const seen = out.get(name)
        if (seen !== undefined) {
          throw new Error(
            `two resource classes named ${name}: ${seen.source.fileName} and ${file}; ` +
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

/**
 * One class's capability values, resolved up its extends chain.
 *
 * The three boolean capabilities are optional members of the `Resource`
 * interface with no `BaseResource` declaration, and every reader coerces
 * with `=== true` (`resource/base.ts`), so a class that declares none of
 * them is false — not undefined. `indexTtl` does have a `BaseResource`
 * default and is picked up by the same walk.
 *
 * Args:
 *   className: the class the registry constructs.
 *   classes: every reachable resource class, from `collectClasses`.
 */
export function capabilitiesOf(className: string, classes: Map<string, ClassInfo>): Capabilities {
  const ancestry = chain(className, classes)
  if (ancestry.length === 0)
    throw new Error(`no source declaration for resource class ${className}`)
  const values: Record<string, number | boolean | string> = {}
  for (const info of ancestry) {
    for (const member of info.decl.members) {
      if (!ts.isPropertyDeclaration(member)) continue
      const name = member.name.getText(info.source)
      if (!(CAPABILITY_FIELDS as readonly string[]).includes(name)) continue
      if (name in values) continue
      values[name] = literalValue(member.initializer)
    }
  }
  const overrides = ancestry.filter((info) => info.decl.name?.text !== BASE_CLASS)
  return {
    index_ttl: values.indexTtl ?? 600,
    caches_reads: values.cachesReads ?? false,
    supports_snapshot: values.supportsSnapshot ?? false,
    sizes_always_known: values.sizesAlwaysKnown ?? false,
    storage_id: overrides.some((info) => declaresMethod(info, 'storageId')),
    statfs: overrides.some((info) => declaresMethod(info, 'statfs')),
  }
}

// The value of a named constant a slot was set to, followed one import
// hop. `maxGlobMatches: SCOPE_ERROR` is the whole reason this exists:
// reporting the name instead of 5000 would make the two languages differ
// on a value they agree about.
function resolveIdentifier(
  source: ts.SourceFile,
  name: string,
): number | boolean | string | undefined {
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

// The file a local name was imported from, and the name it has there.
// `import { read as s3Read }` binds `s3Read` locally to an exported
// `read`, so both halves are needed to find the declaration.
function importedFrom(
  source: ts.SourceFile,
  local: string,
): { file: string; exported: string } | undefined {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if (element.name.text !== local) continue
      const specifier = (statement.moduleSpecifier as ts.StringLiteral).text
      if (!specifier.startsWith('.')) return undefined
      const file = resolve(source.fileName, '..', specifier)
      if (!existsSync(file)) return undefined
      return { file, exported: (element.propertyName ?? element.name).text }
    }
  }
  return undefined
}

// Whether a backend's whole-file read declares a fourth parameter, i.e.
// the `{offset, size}` window the `readRange` slot exists to hand it.
// Parameter count rather than arity, because optional and defaulted
// parameters do not show up in `Function.length` — `read(a, b, c?, opts =
// {})` reports 2 at runtime, so nothing observable at runtime can answer
// this question.
function takesWindow(source: ts.SourceFile, local: string): boolean {
  const origin = importedFrom(source, local)
  if (origin === undefined) return false
  const declared = parse(origin.file)
  for (const statement of declared.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue
    if (statement.name.text !== origin.exported) continue
    const options = statement.parameters[3]?.type
    if (options === undefined) return false
    // The fourth parameter is not automatically a byte window — linear's
    // is a `ReadFilter` of query terms — so the type has to declare an
    // `offset` before this counts as a range the slot could carry.
    if (ts.isTypeLiteralNode(options)) return declaresOffset(options.members)
    if (!ts.isTypeReferenceNode(options) || !ts.isIdentifier(options.typeName)) return false
    return declaresOffsetNamed(declared, options.typeName.text)
  }
  return false
}

// A byte window is `offset` *and* `size`, the pair python's own opt-in
// test keys on. `offset` alone is not enough: postgres pairs it with
// `limit` to mean a SQL row range, which no byte slot can carry.
function declaresOffset(members: ts.NodeArray<ts.TypeElement>): boolean {
  const names = new Set(members.filter((m) => m.name !== undefined).map((m) => m.name?.getText()))
  return names.has('offset') && names.has('size')
}

function declaresOffsetNamed(source: ts.SourceFile, name: string): boolean {
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === name) {
      return declaresOffset(statement.members)
    }
  }
  const origin = importedFrom(source, name)
  if (origin === undefined) return false
  for (const statement of parse(origin.file).statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === origin.exported) {
      return declaresOffset(statement.members)
    }
  }
  return false
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
 *   registryFile: absolute path to the variant's `resource/registry.ts`.
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
          // `GitHubResource.create(...)` and `DatabricksVolumeResource
          // .create(...)` are async static factories, so the class never
          // appears under `new`.
          if (
            ts.isPropertyAccessExpression(child) &&
            child.name.text === 'create' &&
            ts.isIdentifier(child.expression) &&
            child.expression.text.endsWith('Resource')
          ) {
            classes.add(child.expression.text)
          }
          ts.forEachChild(child, scan)
        }
        scan(prop.initializer)
        const resourceClasses = [...classes].filter((c) => c.endsWith('Resource'))
        if (resourceClasses.length === 0 && refuses(prop.initializer)) {
          // Registered so the name resolves and the error explains why,
          // but there is no class to read capabilities from — the browser
          // does this for lancedb (native addon) and email (raw TCP).
          out.set(name, null)
          continue
        }
        if (resourceClasses.length !== 1) {
          throw new Error(
            `registry entry ${name} constructs ${resourceClasses.length} resource classes ` +
              `(${resourceClasses.join(', ') || 'none'}); the capability dump needs exactly one`,
          )
        }
        out.set(name, resourceClasses[0] as string)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (out.size === 0) throw new Error(`no REGISTRY object literal found in ${registryFile}`)
  return out
}

/**
 * The wired `CommandIO` slots per backend command directory.
 *
 * The adapter's slot set is a hand-filled literal that nothing reads, so
 * a backend can omit `du` or `find` and quietly fall back to the capped
 * readdir walk while its twin pushes the work down. Dumping the key set
 * makes that omission a spec diff.
 *
 * Args:
 *   packagesRoot: the `typescript/packages` directory.
 *   pkgs: package names to scan, in the variant's resolution order.
 */
export function commandIoFacts(
  packagesRoot: string,
  pkgs: readonly string[],
  defaults: { maxGlobMatches: number; maxDuEntries: number },
): Record<string, CommandIoFacts> {
  const out: Record<string, CommandIoFacts> = {}
  for (const pkg of pkgs) {
    const root = resolve(packagesRoot, pkg, 'src', 'commands', 'builtin')
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = resolve(root, entry.name, 'io.ts')
      if (!existsSync(file)) continue
      const source = parse(file)
      let literal: ts.ObjectLiteralExpression | undefined
      const visit = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text.endsWith('_IO') &&
          node.initializer !== undefined &&
          ts.isObjectLiteralExpression(node.initializer)
        ) {
          if (literal !== undefined) {
            throw new Error(`${file} declares more than one *_IO object literal`)
          }
          literal = node.initializer
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      if (literal === undefined) continue
      const slots: string[] = []
      const values: Record<string, number | boolean | string> = {}
      let readBytes: string | undefined
      for (const prop of literal.properties) {
        if (ts.isSpreadAssignment(prop)) {
          throw new Error(
            `${file} spreads into its *_IO literal; the slot dump cannot see through it`,
          )
        }
        const name = prop.name?.getText(source)
        if (name === undefined) continue
        if (IO_VALUE_FIELDS.has(name)) {
          let value = ts.isPropertyAssignment(prop) ? literalValue(prop.initializer) : true
          if (
            ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.initializer) &&
            typeof value === 'string'
          ) {
            value = resolveIdentifier(source, prop.initializer.text) ?? value
          }
          values[name] = value
          continue
        }
        if (
          name === 'readBytes' &&
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.initializer)
        ) {
          readBytes = prop.initializer.text
        }
        slots.push(snake(name))
      }
      // A reader that already takes a window but no `readRange` slot is
      // the silent case: the ops factory reads the whole object and
      // slices, which is correct, quiet, and throws the pushdown away.
      // Python asserts the same rule from its own signatures
      // (tests/commands/test_read_range_optin.py); without this the two
      // sides can only diverge, never be caught.
      if (
        !slots.includes('read_range') &&
        readBytes !== undefined &&
        takesWindow(source, readBytes)
      ) {
        throw new Error(
          `${file}: readBytes takes a byte window but no readRange slot is wired, ` +
            `so every ranged read downloads the whole object and slices — ` +
            `add \`readRange: rangeOf(${readBytes})\``,
        )
      }
      out[entry.name] = {
        slots: slots.sort(),
        local: values.local === undefined ? true : values.local === true,
        max_glob_matches: numeric(values.maxGlobMatches, defaults.maxGlobMatches),
        max_du_entries: numeric(values.maxDuEntries, defaults.maxDuEntries),
      }
    }
  }
  return out
}

function numeric(value: number | boolean | string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback
  return typeof value === 'number' ? value : null
}

// ---------------------------------------------------------------------------
// Config field sets: what a mount can be told.
//
// Python dumps its pydantic wire names off the model. TypeScript's twin is
// the zod schema behind each `normalize*Config` door, and it is read from
// the source rather than observed, for the same reason capabilities are:
// most schemas are module-private, and constructing a resource to reach one
// is not inert. The walk follows exactly the forms the config modules use --
// a door call in the exported function, `alias.normalize` off one of the
// S3 factories, a re-exported normalizer -- and throws on any other, so a
// new form fails the dump rather than emitting a row that reads as "no
// divergence here".
// ---------------------------------------------------------------------------

export interface ConfigFacts {
  fields: Record<string, { required: boolean }>
  rename: Record<string, string>
  validates: boolean
}

const DOOR = 'parseConfigWithSchema'
const NORMALIZER_RE = /^normalize\w*Config$/

type Bound = { expr: ts.Expression; source: ts.SourceFile }
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
// following both the relative specifiers `importedFrom` handles and the
// `@struktoai/mirage-core/...` subpaths the node and browser packages use.
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

// The `rename` map a door applies, resolved through any const or spread.
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
function doorCall(body: ts.Node): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined
  const visit = (node: ts.Node): void => {
    if (
      found === undefined &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === DOOR
    ) {
      found = node
    }
    ts.forEachChild(node, visit)
  }
  visit(body)
  return found
}

function factsOfDoor(
  call: ts.CallExpression,
  source: ts.SourceFile,
  env: Env,
  packagesRoot: string,
  label: string,
): ConfigFacts {
  const schema = call.arguments[0]
  if (schema === undefined) throw new Error(`${label}: ${DOOR} without a schema`)
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
    const call = fn.body === undefined ? undefined : doorCall(fn.body)
    if (call === undefined) return { fields: {}, rename: {}, validates: false }
    return factsOfDoor(call, source, new Map(), packagesRoot, label)
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
    const call = body === undefined ? undefined : doorCall(body)
    if (call === undefined) return { fields: {}, rename: {}, validates: false }
    return factsOfDoor(call, factory.source, env, packagesRoot, label)
  }
  throw new Error(
    `${label}: unsupported normalizer declaration ${init.getText(source).slice(0, 60)}`,
  )
}

/**
 * Per registry name, the config field set behind its normalizer.
 *
 * Args:
 *   registryFile: absolute path to the variant's `resource/registry.ts`.
 *   packagesRoot: absolute path to `typescript/packages`.
 *
 * A name whose factory calls no `normalize*Config` (ram, disk, redis take
 * raw kwargs, as their python twins do) dumps null.
 */
export function configFacts(
  registryFile: string,
  packagesRoot: string,
): Record<string, ConfigFacts | null> {
  const out: Record<string, ConfigFacts | null> = {}
  const entries = registryNormalizers(registryFile, packagesRoot)
  for (const [resource, normalizer] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    out[resource] =
      normalizer === null
        ? null
        : factsOfNormalizer(normalizer.file, normalizer.name, packagesRoot, `configs[${resource}]`)
  }
  return out
}
