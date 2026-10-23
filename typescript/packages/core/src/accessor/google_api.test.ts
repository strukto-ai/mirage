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

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { CalendarClient } from '../core/gcal/api.ts'
import { DocsClient } from '../core/gdocs/api.ts'
import { DriveClient } from '../core/gdrive/api.ts'
import { GmailClient } from '../core/gmail/api.ts'
import type { TokenManager } from '../core/google/client.ts'
import { SheetsClient } from '../core/gsheets/api.ts'
import { SlidesClient } from '../core/gslides/api.ts'
import { GoogleApiAccessor } from './google_api.ts'

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const CORE = join(SRC, 'core')
const ACCESSORS = join(SRC, 'accessor')
const PACKAGES = ['gcal', 'gdocs', 'gdrive', 'gmail', 'google', 'gsheets', 'gslides']
// The modules that build Google requests from a token manager: each package's
// client, and the request helpers those clients and the gws CLI call. Every
// other module in a Google package goes through its accessor's client.
// Mirrors Python's `WIRE`.
const WIRE = new Set([
  'gcal/client.ts',
  'gdocs/write.ts',
  'gmail/history.ts',
  'gmail/labels.ts',
  'gmail/messages.ts',
  'gmail/send.ts',
  'google/client.ts',
  'google/drive.ts',
  'gsheets/write.ts',
])

// Requests made without a token manager in hand: the shared HTTP helpers and
// the token exchange. Mirrors Python's `RAW`.
const RAW = new Set(['apiRequest', 'apiStream', 'refreshAccessToken'])

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}

function takesTokenManager(params: ts.NodeArray<ts.ParameterDeclaration>): boolean {
  return params.some((p) => p.type !== undefined && /\bTokenManager\b/.test(p.type.getText()))
}

function exported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    : false
}

/**
 * The names a module exports that are a token manager or are called with one:
 * the one way to a Google request. An accessor is the door itself.
 */
function wireNames(file: string): Set<string> {
  const found = new Set<string>()
  if (file.startsWith(ACCESSORS + sep)) return found
  const source = parse(file)
  const local = new Set<string>()
  for (const node of source.statements) {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      if (takesTokenManager(node.parameters)) local.add(node.name.text)
    } else if (ts.isClassDeclaration(node) && node.name !== undefined) {
      const ctor = node.members.find(ts.isConstructorDeclaration)
      if (node.name.text === 'TokenManager' || (ctor && takesTokenManager(ctor.parameters))) {
        local.add(node.name.text)
      }
    }
  }
  for (const node of source.statements) {
    if (ts.isExportAssignment(node) && local.has(node.expression.getText(source))) {
      found.add('default')
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier === undefined &&
      node.exportClause !== undefined &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const el of node.exportClause.elements) {
        if (local.has((el.propertyName ?? el.name).text)) found.add(el.name.text)
      }
    }
    if (ts.isFunctionDeclaration(node) && exported(node) && node.name !== undefined) {
      if (takesTokenManager(node.parameters)) found.add(node.name.text)
    } else if (ts.isClassDeclaration(node) && exported(node) && node.name !== undefined) {
      const ctor = node.members.find(ts.isConstructorDeclaration)
      if (node.name.text === 'TokenManager' || (ctor && takesTokenManager(ctor.parameters))) {
        found.add(node.name.text)
      }
    } else if (ts.isVariableStatement(node) && exported(node)) {
      for (const decl of node.declarationList.declarations) {
        const init = decl.initializer
        if (
          ts.isIdentifier(decl.name) &&
          init !== undefined &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
          takesTokenManager(init.parameters)
        ) {
          found.add(decl.name.text)
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const from = target(dirname(file), (node.moduleSpecifier as ts.StringLiteral).text)
      const reexported = wireNames(from)
      if (node.exportClause === undefined) reexported.forEach((n) => found.add(n))
      else if (ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          if (reexported.has((el.propertyName ?? el.name).text)) found.add(el.name.text)
        }
      }
    }
  }
  return found
}

/** The module file a relative specifier names, as the bundler resolves it. */
function target(dir: string, specifier: string): string {
  const base = resolve(dir, specifier)
  const tried = [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')]
  const found = tried.find((file) => file.endsWith('.ts') && existsSync(file))
  if (found === undefined) throw new Error(`cannot resolve ${specifier} from ${dir}`)
  return found
}

/** Where `source` reaches a request with no import: raw fetch, or the token manager past its config. */
function rawRequests(file: ts.SourceFile): string[] {
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'fetch') {
      found.push('fetch()')
    } else if (ts.isPropertyAccessExpression(node) && node.name.text === 'tokenManager') {
      const parent = node.parent
      const readsConfig = ts.isPropertyAccessExpression(parent) && parent.name.text === 'config'
      if (!readsConfig) found.push(`${node.getText(file)} past its config`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

function dynamicImport(node: ts.Node): boolean {
  return (
    (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
    (ts.forEachChild(node, dynamicImport) ?? false)
  )
}

/** Every import in `source`, a module in `dir`, that reaches a Google request past `accessor`. */
function wireImports(source: string, dir: string): string[] {
  const file = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true)
  const found = dynamicImport(file) ? ['import()'] : []
  found.push(...rawRequests(file))
  for (const node of file.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue
    if (node.moduleSpecifier === undefined || !ts.isStringLiteral(node.moduleSpecifier)) continue
    const specifier = node.moduleSpecifier.text
    if (!specifier.startsWith('.')) continue
    const typeOnly = ts.isImportDeclaration(node)
      ? node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
      : node.isTypeOnly
    if (typeOnly) continue
    const wire = wireNames(target(dir, specifier))
    const defaultName = ts.isImportDeclaration(node) ? node.importClause?.name : undefined
    if (defaultName !== undefined && wire.has('default')) found.push(defaultName.text)
    const bindings = ts.isImportDeclaration(node)
      ? node.importClause?.namedBindings
      : node.exportClause
    if (bindings === undefined) continue
    if (!('elements' in bindings)) {
      if (wire.size > 0) found.push(`* from ${specifier}`)
      continue
    }
    for (const binding of bindings.elements) {
      const name = (binding.propertyName ?? binding.name).text
      if (!binding.isTypeOnly && (wire.has(name) || RAW.has(name))) found.push(binding.name.text)
    }
  }
  return found
}

function modules(): string[] {
  return PACKAGES.flatMap((pkg) =>
    readdirSync(join(CORE, pkg))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => `${pkg}/${name}`),
  ).sort()
}

describe('the Google seams', () => {
  const GDRIVE = join(CORE, 'gdrive')

  it.each([
    "import { FOLDER_MIME, listFiles } from '../google/drive.ts'",
    "import { googleGet } from '../google/client.ts'",
    "import { TokenManager } from '../google/client.ts'",
    "import * as wire from '../google/drive.ts'",
    "export { deleteFile } from '../google/drive.ts'",
    "import { getMessageRaw } from '../gmail/messages.ts'",
    "import * as messages from '../gmail/messages.ts'",
    "import { listEvents } from '../gcal/client.ts'",
    "import { appendText } from '../gdocs/write.ts'",
    "import { DriveClient } from './api.ts'",
    "import { DriveClient } from './api.js'",
    "import { GmailClient } from '../gmail/api.ts'",
    "const wire = await import /* lazy */ ('../google/drive.ts')",
    "import { listFiles } from '../google/drive'",
    "import { apiRequest } from '../api/client.ts'",
    "import { refreshAccessToken } from '../google/client.ts'",
    'const answer = await fetch(url)',
    'await googleGet(accessor.tokenManager, url)',
  ])('flags %j', (source) => {
    expect(wireImports(source, GDRIVE)).not.toEqual([])
  })

  it.each([
    "import { FOLDER_MIME, MIME_TO_EXT, type DriveFile } from '../google/drive.ts'",
    "import { feedCheckpoint, feedState } from '../google/events.ts'",
    "import { GoogleApiError } from '../google/client.ts'",
    "import { resolveAppEntry } from '../google/entry.ts'",
    "import type { DriveApi } from './api.ts'",
    "import { messageJsonBytes } from '../gmail/messages.ts'",
    "import { listed } from '../gcal/client.ts'",
    "import type { TokenManager } from '../google/client.ts'",
    "import type { GDocsAccessor } from '../../accessor/gdocs.ts'",
    'const folderId = accessor.tokenManager.config.folderId',
  ])('allows %j', (source) => {
    expect(wireImports(source, GDRIVE)).toEqual([])
  })

  it('no Google module reaches a request past its accessor', () => {
    const offenders: [string, string[]][] = []
    for (const name of modules()) {
      if (name.endsWith('/api.ts') || WIRE.has(name)) continue
      const file = join(CORE, name)
      const found = wireImports(readFileSync(file, 'utf8'), dirname(file))
      if (found.length > 0) offenders.push([name, found])
    }
    expect(offenders).toEqual([])
  })

  it('no wire module takes an accessor', () => {
    const names = new Set(modules())
    expect([...WIRE].filter((name) => !names.has(name))).toEqual([])
    const takers = [...WIRE].filter((name) =>
      readFileSync(join(CORE, name), 'utf8').includes('/accessor/'),
    )
    expect(takers).toEqual([])
  })
})

describe('GoogleApiAccessor', () => {
  const TOKEN_MANAGER = { config: {} } as TokenManager

  // A protocol is an interface, gone at runtime, so its calls are read from
  // the source. Mirrors Python's `test_each_live_client_makes_only_its_protocols_calls`.
  it.each([
    ['gdrive', 'DriveApi', DriveClient],
    ['gdocs', 'DocsApi', DocsClient],
    ['gsheets', 'SheetsApi', SheetsClient],
    ['gslides', 'SlidesApi', SlidesClient],
    ['gmail', 'GmailApi', GmailClient],
    ['gcal', 'CalendarApi', CalendarClient],
  ] as const)("the %s client makes only its protocol's calls", (pkg, protocol, Client) => {
    const source = parse(join(CORE, pkg, 'api.ts'))
    const declared = source.statements.find(
      (node): node is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(node) && node.name.text === protocol,
    )
    const calls = (declared?.members ?? []).map((m) => m.name?.getText(source)).sort()
    const made = Object.getOwnPropertyNames(Client.prototype)
      .filter((name) => name !== 'constructor')
      .sort()
    expect(made).toEqual(calls)
  })

  it.each([
    ['drive', DriveClient],
    ['docs', DocsClient],
    ['sheets', SheetsClient],
    ['slides', SlidesClient],
    ['gmail', GmailClient],
    ['calendar', CalendarClient],
  ] as const)('serves the live %s client', (service, Client) => {
    const client = new GoogleApiAccessor({ tokenManager: TOKEN_MANAGER })[service]
    expect(client).toBeInstanceOf(Client)
    expect((client as unknown as { tokenManager: TokenManager }).tokenManager).toBe(TOKEN_MANAGER)
  })
})
