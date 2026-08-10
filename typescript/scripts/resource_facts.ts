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
