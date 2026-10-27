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

import type { S3Client } from '@aws-sdk/client-s3'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { S3HttpAgents } from '../../vfs/s3/config.ts'
import { DENIED_CASES, LOST_CODES, sdkError } from '../../../tests/core/s3/_test_util.ts'
import { createS3Client, isConditionLost, isDenied } from './client.ts'

interface ResolvedHandlerConfig {
  connectionTimeout?: number
  requestTimeout?: number
  httpAgent?: unknown
  httpAgentProvider?: () => Promise<unknown>
  httpsAgent?: unknown
}

function makeAgents(): S3HttpAgents {
  return { httpAgent: { destroy: () => undefined }, httpsAgent: { destroy: () => undefined } }
}

// The SDK builds the NodeHttpHandler itself from the options object we hand it
// and resolves that config lazily, so read it back through `configProvider`.
function resolvedHandlerConfig(client: S3Client): Promise<ResolvedHandlerConfig> {
  const handler = client.config.requestHandler as unknown as {
    configProvider: Promise<ResolvedHandlerConfig>
  }
  return handler.configProvider
}

describe('S3 client', () => {
  it('forwards runtime-provided agents into the request handler', async () => {
    const agents = makeAgents()
    const client = await createS3Client({ bucket: 'b', httpAgentProvider: () => agents })
    const resolved = await resolvedHandlerConfig(client)
    const httpAgent = (await resolved.httpAgentProvider?.()) ?? resolved.httpAgent
    expect(httpAgent).toBe(agents.httpAgent)
    expect(resolved.httpsAgent).toBe(agents.httpsAgent)
    client.destroy()
  })

  // Every S3 op destroys its own client when it finishes. Agents must therefore
  // be per-client: a shared pair would let one op's cleanup tear down sockets a
  // concurrent op is still using (e.g. `ls -l`, which stats entries in parallel).
  it('asks the provider for fresh agents per client so destroy() stays scoped', async () => {
    const seen: unknown[] = []
    const provider = (): S3HttpAgents => {
      const agents = makeAgents()
      seen.push(agents.httpsAgent)
      return agents
    }
    const config = { bucket: 'b', httpAgentProvider: provider }
    const a = await createS3Client(config)
    const b = await createS3Client(config)
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
    expect(await resolvedHandlerConfig(a)).not.toBe(await resolvedHandlerConfig(b))
    a.destroy()
    b.destroy()
  })

  // A named profile that never reaches the client is worse than one that
  // errors: the default chain quietly signs with whatever credentials it
  // finds, so reads can hit the wrong account. Python honours it through
  // `aioboto3.Session(profile_name=...)`.
  it('forwards a named profile to the credential chain', async () => {
    const client = await createS3Client({ bucket: 'b', profile: 'staging' })
    expect(client.config.profile).toBe('staging')
    client.destroy()
  })

  it('lets explicit keys win over a profile, as Python does', async () => {
    const client = await createS3Client({
      bucket: 'b',
      profile: 'staging',
      accessKeyId: 'AKIA',
      secretAccessKey: 'SECRET',
    })
    const creds = await client.config.credentials()
    expect(creds.accessKeyId).toBe('AKIA')
    client.destroy()
  })

  it('keeps timeouts alongside provided agents', async () => {
    const agents = makeAgents()
    const client = await createS3Client({
      bucket: 'b',
      timeout: 5,
      httpAgentProvider: () => agents,
    })
    const resolved = await resolvedHandlerConfig(client)
    expect(resolved.requestTimeout).toBe(5000)
    expect(resolved.connectionTimeout).toBe(5000)
    expect(resolved.httpsAgent).toBe(agents.httpsAgent)
    client.destroy()
  })
})

describe('isConditionLost', () => {
  it.each(LOST_CODES.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(isConditionLost(sdkError(c.code, c.status))).toBe(c.lost)
  })

  it.each([
    // The SDK names a bodiless reply Unknown; its status is the code.
    ['412-unknown', sdkError('Unknown', 412), true],
    ['409-unknown', sdkError('Unknown', 409), true],
    ['transport', new Error('socket hang up'), false],
  ] as const)('%s', (_name, err, lost) => {
    expect(isConditionLost(err)).toBe(lost)
  })
})

describe('isDenied', () => {
  it.each(DENIED_CASES.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(isDenied(sdkError(c.code, c.status))).toBe(c.denied)
  })

  it.each([
    // The SDK names a bodiless reply Unknown; its status is the code.
    ['403-unknown', sdkError('Unknown', 403), true],
    ['404-unknown', sdkError('Unknown', 404), false],
    ['transport', new Error('socket hang up'), false],
  ] as const)('%s', (_name, err, denied) => {
    expect(isDenied(err)).toBe(denied)
  })
})

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// The one place an S3 client is built, which every test seam stubs.
const SEAM = 'core/s3/client.ts'

/** What one module does to open an S3 client past the seam. */
function s3Bypasses(source: string): string[] {
  const found = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith('@aws-sdk/')
    ) {
      const typeOnly = ts.isImportDeclaration(node)
        ? node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
        : node.isTypeOnly
      if (!typeOnly) found.add(`import ${node.moduleSpecifier.text}`)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text.startsWith('@aws-sdk/')
    ) {
      found.add(`import(${node.arguments[0].text})`)
    } else if (ts.isNewExpression(node)) {
      const callee = node.expression
      const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee
      if (ts.isIdentifier(name) && name.text === 'S3Client') found.add('new S3Client')
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest))
  return [...found].sort()
}

function bypassingModules(root: string): Record<string, string[]> {
  const offenders: Record<string, string[]> = {}
  for (const name of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
    const module = name.split(sep).join('/')
    if (module === SEAM || module.startsWith('generated/')) continue
    const source = readFileSync(join(root, name), 'utf8')
    if (!source.includes('@aws-sdk/') && !source.includes('S3Client')) continue
    const found = s3Bypasses(source)
    if (found.length > 0) offenders[module] = found
  }
  return offenders
}

describe('the S3 client seam', () => {
  it.each([
    ["import { S3Client } from '@aws-sdk/client-s3'", ['import @aws-sdk/client-s3']],
    ["import * as s3 from '@aws-sdk/client-s3'", ['import @aws-sdk/client-s3']],
    ["import '@aws-sdk/client-s3'", ['import @aws-sdk/client-s3']],
    ["export { S3Client } from '@aws-sdk/client-s3'", ['import @aws-sdk/client-s3']],
    ["await import('@aws-sdk/client-s3')", ['import(@aws-sdk/client-s3)']],
    ['new mod.S3Client({})', ['new S3Client']],
    ['new S3Client({})', ['new S3Client']],
  ])('catches a planted bypass: %s', (source, expected) => {
    expect(s3Bypasses(source)).toEqual(expected)
  })

  it.each([
    "import type { S3Client } from '@aws-sdk/client-s3'",
    "import { createS3Client } from './client.ts'",
    'await createS3Client(config)',
  ])('leaves what opens through the seam: %s', (source) => {
    expect(s3Bypasses(source)).toEqual([])
  })

  it('fails on a planted module and spares the seam', () => {
    const root = mkdtempSync(join(tmpdir(), 's3-seam-'))
    try {
      mkdirSync(join(root, 'core', 's3'), { recursive: true })
      writeFileSync(join(root, 'core', 's3', 'planted.ts'), 'new mod.S3Client({})\n')
      writeFileSync(join(root, SEAM), "await import('@aws-sdk/client-s3')\n")
      expect(bypassingModules(root)).toEqual({ 'core/s3/planted.ts': ['new S3Client'] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still sees the seam open its client', () => {
    expect(s3Bypasses(readFileSync(join(SRC_DIR, SEAM), 'utf8'))).toEqual([
      'import(@aws-sdk/client-s3)',
      'new S3Client',
    ])
  })

  // It reads every source file, which a loaded runner can take past the
  // default 5 s for.
  it('opens every S3 client through createS3Client', () => {
    expect(bypassingModules(SRC_DIR)).toEqual({})
  }, 30_000)
})
