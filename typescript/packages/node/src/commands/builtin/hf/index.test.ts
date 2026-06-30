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

import { describe, expect, it } from 'vitest'
import { HF_RESOURCES } from '../../../accessor/hf.ts'
import { HF_COMMANDS } from './index.ts'

const EXPECTED_NAMES = [
  'awk',
  'base64',
  'basename',
  'cat',
  'cmp',
  'column',
  'comm',
  'csplit',
  'cut',
  'diff',
  'dirname',
  'du',
  'expand',
  'file',
  'find',
  'fmt',
  'fold',
  'grep',
  'gunzip',
  'gzip',
  'head',
  'iconv',
  'join',
  'jq',
  'look',
  'ls',
  'md5',
  'mktemp',
  'nl',
  'paste',
  'readlink',
  'realpath',
  'rev',
  'rg',
  'rm',
  'sed',
  'sha256sum',
  'shuf',
  'sort',
  'split',
  'stat',
  'strings',
  'tac',
  'tail',
  'tar',
  'touch',
  'tr',
  'tree',
  'tsort',
  'unexpand',
  'uniq',
  'unzip',
  'wc',
  'xxd',
  'zcat',
  'zgrep',
  'zip',
]

describe('HF_COMMANDS', () => {
  it('registers the python hf_buckets command list', () => {
    const names = new Set(HF_COMMANDS.map((c) => c.name))
    for (const name of EXPECTED_NAMES) {
      expect(names.has(name)).toBe(true)
    }
  })

  it('registers every command for all four hf resources', () => {
    const byName = new Map<string, Set<string>>()
    for (const cmd of HF_COMMANDS) {
      const set = byName.get(cmd.name) ?? new Set<string>()
      if (cmd.resource !== null) set.add(cmd.resource)
      byName.set(cmd.name, set)
    }
    for (const [name, resources] of byName.entries()) {
      expect([name, [...resources].sort()]).toEqual([name, [...HF_RESOURCES].sort()])
    }
  })
})
