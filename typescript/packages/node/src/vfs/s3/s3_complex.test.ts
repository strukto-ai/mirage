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

import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Workspace } from '../../workspace.ts'
import { S3VFS } from './s3.ts'
import type { S3Config } from '@struktoai/mirage-core/vfs/direct/s3'
import { installS3Mock, type S3Mock } from '../../../tests/vfs/s3/mock.ts'

const BUCKET = 'test-bucket'
const DEC = new TextDecoder()
const ENC = new TextEncoder()

function decode(bytes: Uint8Array): string {
  return DEC.decode(bytes)
}

function s3Objects(): Record<string, Uint8Array> {
  return {
    'data/example.json': ENC.encode('{"company": "Strukto"}\n'),
    'data/example.jsonl': ENC.encode(
      '{"type": "user", "text": "open the mirage docs"}\n{"type": "assistant", "text": "done"}\n',
    ),
    'reports/summary.txt': ENC.encode('alpha report\nbeta report\n'),
    'archive/2026/q1/deep.txt': ENC.encode('deep archive\n'),
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
