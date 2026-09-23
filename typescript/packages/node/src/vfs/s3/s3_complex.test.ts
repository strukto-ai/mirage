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

import { openSync, closeSync, readSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Workspace } from '../../workspace.ts'
import { S3VFS } from './s3.ts'
import type { S3Config } from './config.ts'
import { installS3Mock, type S3Mock } from './mock.ts'

const DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../data',
)
const BUCKET = 'test-bucket'
const DEC = new TextDecoder()

function decode(bytes: Uint8Array): string {
  return DEC.decode(bytes)
}

function loadExampleJsonl(limit = 20): Uint8Array {
  const fd = openSync(path.join(DATA_DIR, 'example.jsonl'), 'r')
  try {
    const buffer = Buffer.alloc(1 << 20)
    let filled = 0
    while (filled < buffer.byteLength) {
      const n = readSync(fd, buffer, filled, buffer.byteLength - filled, null)
      if (n === 0) break
      filled += n
    }
    const all = buffer.subarray(0, filled).toString('utf8')
    const lines: string[] = []
    let start = 0
    for (let i = 0; i < all.length && lines.length < limit; i++) {
      if (all[i] === '\n') {
        lines.push(all.slice(start, i + 1))
        start = i + 1
      }
    }
    return new TextEncoder().encode(lines.join(''))
  } finally {
    closeSync(fd)
  }
}

function s3Objects(): Record<string, Uint8Array> {
  const exampleJson = new Uint8Array(readFileSync(path.join(DATA_DIR, 'example.json')))
  const exampleJsonl = loadExampleJsonl()
  return {
    'data/example.json': exampleJson,
    'data/example.jsonl': exampleJsonl,
    'reports/summary.txt': new TextEncoder().encode('alpha report\nbeta report\n'),
    'archive/2026/q1/deep.txt': new TextEncoder().encode('deep archive\n'),
  }
}

function makeS3Config(): S3Config {
  return {
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: 'fake',
    secretAccessKey: 'fake',
    forcePathStyle: true,
  }
}

describe('S3 complex scenarios (mocked)', () => {
  let mock: S3Mock
  let ws: Workspace
  let objects: Record<string, Uint8Array>

  beforeAll(() => {
    mock = installS3Mock()
  })

  beforeEach(() => {
    objects = s3Objects()
    for (const [k, v] of Object.entries(objects)) {
      mock.store.set(BUCKET, k, v)
    }
    ws = new Workspace(
      {
        '/s3/': new S3VFS(makeS3Config()),
        '/tmp/': new RAMVFS(),
      },
      { mode: MountMode.WRITE },
    )
  })

  afterEach(async () => {
    await ws.close()
    for (const b of mock.store.allBuckets()) {
      mock.store.objects(b).clear()
    }
  })

  afterAll(() => {
    mock.restore()
  })

  it('find -maxdepth 2 -type f lists expected S3 files', async () => {
    const io = await ws.shell('find /s3 -maxdepth 2 -type f | sort')
    const lines = decode(io.stdout).trim().split('\n')
    expect(lines).toEqual([
      '/s3/data/example.json',
      '/s3/data/example.jsonl',
      '/s3/reports/summary.txt',
    ])
  })

  it('file report through redirect chain', async () => {
    const io = await ws.shell(
      "echo '=== /s3/data/example.json ===' > /tmp/file_report.txt && " +
        'file /s3/data/example.json >> /tmp/file_report.txt && ' +
        'echo >> /tmp/file_report.txt && ' +
        "echo '=== /s3/data/example.jsonl ===' >> /tmp/file_report.txt && " +
        'file /s3/data/example.jsonl >> /tmp/file_report.txt && ' +
        'echo >> /tmp/file_report.txt && ' +
        "echo '=== /s3/reports/summary.txt ===' " +
        '>> /tmp/file_report.txt && ' +
        'file /s3/reports/summary.txt >> /tmp/file_report.txt && ' +
        'echo >> /tmp/file_report.txt && ' +
        'cat /tmp/file_report.txt',
    )
    const lines = decode(io.stdout).trim().split('\n')
    expect(lines).toEqual([
      '=== /s3/data/example.json ===',
      '/s3/data/example.json: json',
      '',
      '=== /s3/data/example.jsonl ===',
      '/s3/data/example.jsonl: json',
      '',
      '=== /s3/reports/summary.txt ===',
      '/s3/reports/summary.txt: text',
    ])
  })

  it('wc report through redirect chain', async () => {
    const io = await ws.shell(
      "echo -n '/s3/data/example.json ' > /tmp/size_report.txt && " +
        'wc -c /s3/data/example.json >> /tmp/size_report.txt && ' +
        'echo >> /tmp/size_report.txt && ' +
        "echo -n '/s3/data/example.jsonl ' >> /tmp/size_report.txt && " +
        'wc -c /s3/data/example.jsonl >> /tmp/size_report.txt && ' +
        'echo >> /tmp/size_report.txt && ' +
        'cat /tmp/size_report.txt',
    )
    const lines = decode(io.stdout).trim().split('\n')
    const jsonBytes = objects['data/example.json']
    const jsonlBytes = objects['data/example.jsonl']
    if (jsonBytes === undefined || jsonlBytes === undefined) throw new Error('missing fixture')
    expect(lines).toEqual([
      `/s3/data/example.json ${jsonBytes.byteLength.toString()} /s3/data/example.json`,
      '',
      `/s3/data/example.jsonl ${jsonlBytes.byteLength.toString()} /s3/data/example.jsonl`,
    ])
  })

  it('grep then jq with and/or list', async () => {
    const io = await ws.shell(
      'grep -l mirage /s3/data/example.jsonl ' +
        '> /tmp/search_report.txt && ' +
        'echo >> /tmp/search_report.txt && ' +
        'jq .company /s3/data/example.json >> /tmp/search_report.txt || ' +
        'echo missing > /tmp/search_report.txt; ' +
        'cat /tmp/search_report.txt',
    )
    const lines = decode(io.stdout).trim().split('\n')
    expect(lines).toEqual(['/s3/data/example.jsonl', '', '"Strukto"'])
  })
})
