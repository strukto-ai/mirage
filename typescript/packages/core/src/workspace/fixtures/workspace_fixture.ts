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
import { createRequire } from 'node:module'
import type { LostPaths } from '../../observe/context.ts'
import type { OpRecord } from '../../observe/record.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { createShellParser, type ShellParser } from '../../shell/parse/index.ts'
import { type CacheFacts, MountMode, type Refusal } from '../../types.ts'
import { Workspace } from '../workspace/workspace.ts'
import { describeRefusal, saysWhy } from '../../policy/index.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parserPromise: Promise<ShellParser> | null = null

export async function getTestParser(): Promise<ShellParser> {
  parserPromise ??= createShellParser({ engineWasm, grammarWasm })
  return parserPromise
}

const ENC = new TextEncoder()
const DEC = new TextDecoder()

/** A writable workspace with a read-caching RAM mount at `/r`. */
export async function cachingRamWorkspace(): Promise<Workspace> {
  const ram = new RAMVFS()
  ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
  return new Workspace({ '/r': ram }, { mode: MountMode.WRITE, shellParser: await getTestParser() })
}

export type Mark = [op: string, path: string]

type KeepVersionsFn = (
  records: readonly OpRecord[],
  cacheFacts: (path: string) => CacheFacts,
  lost: LostPaths | null,
  nested?: boolean,
) => Promise<void>

/**
 * Snapshot the records each line's end keeps versions against, as
 * `[op, path]`, and whether the line was nested. Mirrors Python's
 * `capture_marks`.
 */
export function captureMarks(ws: Workspace): [Mark[], boolean][] {
  const captured: [Mark[], boolean][] = []
  const dispatcher = (ws as unknown as { dispatcher: { keepVersions: KeepVersionsFn } }).dispatcher
  const orig = dispatcher.keepVersions.bind(dispatcher)
  dispatcher.keepVersions = async (records, cacheFacts, lost, nested = false) => {
    captured.push([records.map((r): Mark => [r.op, r.path]), nested])
    await orig(records, cacheFacts, lost, nested)
  }
  return captured
}

export interface TestWorkspace {
  ws: Workspace
  s3: RAMVFS
  disk: RAMVFS
  ram: RAMVFS
}

function putFile(res: RAMVFS, path: string, data: string | Uint8Array): void {
  res.store.files.set(path, typeof data === 'string' ? ENC.encode(data) : data)
}

function putDir(res: RAMVFS, path: string): void {
  res.store.dirs.add(path)
}

export async function makeWorkspace(extra: { agentId?: string } = {}): Promise<TestWorkspace> {
  const parser = await getTestParser()
  const s3 = new RAMVFS()
  const disk = new RAMVFS()
  const ram = new RAMVFS()

  putFile(s3, '/report.csv', 'name,age\nalice,30\nbob,25\n')
  putFile(s3, '/data.txt', 'hello from s3\n')
  putFile(s3, '/users.json', '[{"name":"alice","age":30},{"name":"bob","age":25}]\n')
  putFile(s3, '/config.env', 'DB_HOST=localhost\nDB_PORT=5432\n')
  putFile(
    s3,
    '/access.log',
    '2024-01-01 GET /api 200\n2024-01-01 POST /api 500\n2024-01-02 GET /api 200\n2024-01-02 GET /health 200\n2024-01-03 POST /api 500\n',
  )
  putFile(s3, '/script.py', "import json\ndata = json.loads('[1,2,3]')\nprint(sum(data))\n")

  putFile(disk, '/readme.txt', 'disk readme\n')
  putDir(disk, '/sub')
  putFile(disk, '/sub/deep.txt', 'deep content\n')

  putFile(ram, '/notes.txt', 'line1\nline2\nline3\n')
  putFile(ram, '/nums.txt', '5\n3\n1\n4\n2\n')
  putFile(ram, '/words.txt', 'banana\napple\ncherry\napple\n')

  const ws = new Workspace(
    { '/s3': s3, '/disk': disk, '/ram': ram },
    { mode: MountMode.EXEC, shellParser: parser, ...extra },
  )
  ws.getSession(ws.defaultSessionId).cwd = '/s3'
  return { ws, s3, disk, ram }
}

export function stdoutBytes(io: { stdout: Uint8Array }): Uint8Array {
  return io.stdout
}

export function stdoutStr(io: { stdout: Uint8Array }): string {
  return DEC.decode(io.stdout)
}

export function stderrStr(io: { stderr: Uint8Array }): string {
  return DEC.decode(io.stderr)
}

/**
 * stderr as bash prints it, then the refusal record as one more line,
 * unless the text already says why (an operand-scoped refusal's own GNU
 * line): what a text surface hands an agent.
 */
export function voicedStderr(io: { stderr: Uint8Array; refusal: Refusal | null }): string {
  const text = DEC.decode(io.stderr)
  if (io.refusal === null || saysWhy(text, io.refusal)) return text
  return `${text}${describeRefusal(io.refusal)}\n`
}

export function countOccurrences(buf: Uint8Array, needle: string): number {
  const hay = DEC.decode(buf)
  return hay.split(needle).length - 1
}
