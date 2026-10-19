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

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DriveModule from '../google/drive.ts'

vi.mock('../google/drive.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof DriveModule>()
  const faked: Record<string, unknown> = { ...actual }
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value === 'function') faked[name] = vi.fn()
  }
  return faked
})

import { ByteSpool } from '../../io/spool.ts'
import type { ByteWindow } from '../../utils/ranges.ts'
import * as drive from '../google/drive.ts'
import { TOKEN_MANAGER } from '../../../tests/core/gdrive/_test_util.ts'
import { DriveClient, type DriveApi } from './api.ts'

const GDRIVE_DIR = dirname(fileURLToPath(import.meta.url))
const GOOGLE_DIR = join(dirname(GDRIVE_DIR), 'google')
const SEAM = join(GDRIVE_DIR, 'api')

const REQUEST_FREE_EXPORTS = new Set([
  'feedCheckpoint',
  'feedState',
  'GoogleApiError',
  'FOLDER_MIME',
  'MIME_TO_EXT',
])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(dir, name))
    .sort()
}

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  )
}

/** Every function a `core/google` module exports, less the request-free ones. */
function requestFunctions(): Set<string> {
  const names = new Set<string>()
  for (const file of sourceFiles(GOOGLE_DIR)) {
    for (const statement of parse(file, readFileSync(file, 'utf8')).statements) {
      if (!isExported(statement)) continue
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
        names.add(statement.name.text)
      }
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer
        if (
          ts.isIdentifier(declaration.name) &&
          init !== undefined &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          names.add(declaration.name.text)
        }
      }
    }
  }
  for (const name of REQUEST_FREE_EXPORTS) names.delete(name)
  return names
}

type Target = 'google' | 'seam' | null

function targetOf(file: string, specifier: string): Target {
  if (!specifier.startsWith('.')) return null
  const target = resolve(dirname(file), specifier)
  if (target.startsWith(GOOGLE_DIR + sep)) return 'google'
  return target.replace(/\.[jt]s$/, '') === SEAM ? 'seam' : null
}

/** How the module at `file` reaches Drive other than through `accessor.drive`. */
function seamBypasses(file: string, source: string, wire: Set<string>): string[] {
  const found: string[] = []
  const named = (
    target: Target,
    bindings: readonly ts.ImportSpecifier[] | readonly ts.ExportSpecifier[],
  ) => {
    for (const binding of bindings) {
      if (binding.isTypeOnly) continue
      const name = (binding.propertyName ?? binding.name).text
      if (target === 'seam' || wire.has(name)) found.push(name)
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = targetOf(file, node.moduleSpecifier.text)
      const clause = node.importClause
      if (
        target !== null &&
        clause !== undefined &&
        clause.phaseModifier !== ts.SyntaxKind.TypeKeyword
      ) {
        if (clause.name !== undefined) found.push(`default as ${clause.name.text}`)
        const bindings = clause.namedBindings
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          found.push(`* as ${bindings.name.text}`)
        } else if (bindings !== undefined) {
          named(target, bindings.elements)
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const target = targetOf(file, node.moduleSpecifier.text)
      if (target !== null && !node.isTypeOnly) {
        const clause = node.exportClause
        if (clause === undefined) found.push('*')
        else if (ts.isNamespaceExport(clause)) found.push(`* as ${clause.name.text}`)
        else named(target, clause.elements)
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      targetOf(file, node.arguments[0].text) !== null
    ) {
      found.push(`import(${node.arguments[0].text})`)
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(file, source))
  return found
}

describe('the gdrive drive seam', () => {
  const wire = requestFunctions()
  const plantedAt = join(GDRIVE_DIR, 'planted.ts')
  const planted = (source: string): string[] => seamBypasses(plantedAt, source, wire)

  it('derives the request functions from the google modules', () => {
    for (const name of ['listFiles', 'getFile', 'googleGet', 'driveBase', 'downloadRevision']) {
      expect(wire.has(name), name).toBe(true)
    }
  })

  it('no gdrive core module but the seam reaches Drive past accessor.drive', () => {
    const offenders: [string, string][] = []
    for (const file of sourceFiles(GDRIVE_DIR)) {
      if (file.replace(/\.ts$/, '') === SEAM) continue
      for (const bypass of seamBypasses(file, readFileSync(file, 'utf8'), wire)) {
        offenders.push([relative(GDRIVE_DIR, file), bypass])
      }
    }
    expect(offenders).toEqual([])
  })

  it.each([
    ["import { listFiles } from '../google/drive.ts'", ['listFiles']],
    ["import { getFile as fetchFile } from '../google/drive.ts'", ['getFile']],
    [
      "import {\n  FOLDER_MIME,\n  deleteFile,\n  type DriveFile,\n} from '../google/drive.ts'",
      ['deleteFile'],
    ],
    [
      "import type { DriveFile } from '../google/drive.ts'\nimport { copyFile } from '../google/drive.ts'",
      ['copyFile'],
    ],
    ["import * as wire from '../google/drive.ts'", ['* as wire']],
    ["export { deleteFile } from '../google/drive.ts'", ['deleteFile']],
    ["export * from '../google/client.ts'", ['*']],
    ["const wire = await import('../google/drive.ts')", ['import(../google/drive.ts)']],
    ["import { googleGet } from '../google/client.js'", ['googleGet']],
    ["import { DriveClient } from './api.ts'", ['DriveClient']],
    ["import { getFile } from '../google/entry.ts'", ['getFile']],
  ])('flags %j', (source, expected) => {
    expect(planted(source)).toEqual(expected)
  })

  it.each([
    "import type { DriveFile } from '../google/drive.ts'",
    "import { FOLDER_MIME, MIME_TO_EXT, type DriveFile } from '../google/drive.ts'",
    "import { GoogleApiError } from '../google/client.ts'",
    "import { feedCheckpoint, feedState } from '../google/events.ts'",
    "import type * as wire from '../google/drive.ts'",
    "import type { DriveApi } from './api.ts'",
    "import { listFiles } from '../box/api.ts'",
  ])('allows %j', (source) => {
    expect(planted(source)).toEqual([])
  })
})

const WINDOW: ByteWindow = { offset: 2, size: 4 }
const REVISION_WINDOW: ByteWindow = { offset: 7, size: null }
const BYTES = new Uint8Array([1, 2, 3])
const SPOOL = new ByteSpool()

interface Delegation {
  args: unknown[]
  wire: (...args: never[]) => unknown
  sent: unknown[]
  reply?: unknown
  returns?: unknown
}

const DELEGATIONS: { [K in keyof DriveApi]: Delegation & { args: Parameters<DriveApi[K]> } } = {
  listFiles: {
    args: [{ folderId: 'f1', driveId: 'd1', limit: 1 }],
    wire: drive.listFiles,
    sent: [{ folderId: 'f1', driveId: 'd1', limit: 1 }],
  },
  listChildren: {
    args: [['a', 'b'], 'd2'],
    wire: drive.listChildren,
    sent: [['a', 'b'], 'd2'],
  },
  listSharedDrives: { args: [], wire: drive.listSharedDrives, sent: [] },
  searchFiles: {
    args: ['needle', ['p1', 'p2']],
    wire: drive.searchFiles,
    sent: ['needle', ['p1', 'p2']],
  },
  getFile: { args: ['f2', 'md5Checksum'], wire: drive.getFile, sent: ['f2', 'md5Checksum'] },
  storageQuota: { args: [], wire: drive.storageQuota, sent: [] },
  deleteFile: { args: ['f3'], wire: drive.deleteFile, sent: ['f3'] },
  downloadFile: { args: ['f4', WINDOW], wire: drive.downloadFile, sent: ['f4', WINDOW] },
  downloadFileStream: { args: ['f5'], wire: drive.downloadFileStream, sent: ['f5'] },
  createFolder: { args: ['dir', 'p3'], wire: drive.createFolder, sent: ['dir', 'p3'] },
  uploadFile: {
    args: ['a.txt', 'p4', BYTES],
    wire: drive.uploadFile,
    sent: ['a.txt', 'p4', BYTES],
  },
  updateFileContent: {
    args: ['f6', SPOOL],
    wire: drive.updateFileContent,
    sent: ['f6', SPOOL],
  },
  patchFile: {
    args: ['f7', { body: { name: 'b' }, addParents: 'p6', removeParents: 'p5' }],
    wire: drive.patchFile,
    sent: ['f7', { body: { name: 'b' }, addParents: 'p6', removeParents: 'p5' }],
  },
  copyFile: { args: ['f8', 'c.txt', 'p7'], wire: drive.copyFile, sent: ['f8', 'c.txt', 'p7'] },
  startPageToken: { args: [], wire: drive.startPageToken, sent: [] },
  listChanges: { args: ['t1'], wire: drive.listChanges, sent: ['t1'] },
  captureFileMetadata: {
    args: ['f9'],
    wire: drive.getFile,
    sent: ['f9', 'headRevisionId,md5Checksum'],
    reply: { id: 'f9', name: 'f', headRevisionId: 'r9', md5Checksum: 'abc' },
    returns: ['abc', 'r9'],
  },
  downloadRevision: {
    args: ['f10', 'r1', REVISION_WINDOW],
    wire: drive.downloadRevision,
    sent: ['f10', 'r1', REVISION_WINDOW],
  },
  downloadRevisionStream: {
    args: ['f11', 'r2'],
    wire: drive.downloadRevisionStream,
    sent: ['f11', 'r2'],
  },
}

describe('DriveClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('has a delegation case for every method', () => {
    const methods = Object.getOwnPropertyNames(DriveClient.prototype).filter(
      (name) => name !== 'constructor',
    )
    expect(Object.keys(DELEGATIONS).sort()).toEqual(methods.sort())
  })

  it.each(Object.entries<Delegation>(DELEGATIONS))(
    '%s sends its wire call the token manager and its arguments',
    async (method, row) => {
      const reply = 'reply' in row ? row.reply : Symbol(method)
      vi.mocked(row.wire).mockReturnValue(reply)
      const client = new DriveClient(TOKEN_MANAGER)
      const call = Reflect.get(client, method) as (...a: unknown[]) => unknown
      const answer = await call.apply(client, row.args)
      if ('returns' in row) expect(answer).toEqual(row.returns)
      else expect(answer).toBe(reply)
      expect(row.wire).toHaveBeenCalledTimes(1)
      expect(row.wire).toHaveBeenCalledWith(TOKEN_MANAGER, ...row.sent)
    },
  )

  it('captures a missing md5 or head revision as null', async () => {
    vi.mocked(drive.getFile).mockResolvedValue({ id: 'f1', name: 'f' })
    expect(await new DriveClient(TOKEN_MANAGER).captureFileMetadata('f1')).toEqual([null, null])
  })
})
