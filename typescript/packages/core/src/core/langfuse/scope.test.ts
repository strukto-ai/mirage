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
import { detectScope } from './scope.ts'

describe('langfuse detectScope', () => {
  it('returns root for empty path', () => {
    const s = detectScope('')
    expect(s.level).toBe('root')
    expect(s.resourceType).toBeNull()
    expect(s.resourceId).toBeNull()
  })

  it('returns traces for /traces', () => {
    const s = detectScope('/traces')
    expect(s.level).toBe('traces')
    expect(s.resourceType).toBe('traces')
    expect(s.resourceId).toBeNull()
  })

  it('returns file for traces/<id>.json', () => {
    const s = detectScope('traces/abc123.json')
    expect(s.level).toBe('file')
    expect(s.resourceType).toBe('traces')
    expect(s.resourceId).toBe('abc123')
  })

  it('returns sessions level for sessions/<id>', () => {
    const s = detectScope('sessions/sess1')
    expect(s.level).toBe('sessions')
    expect(s.resourceType).toBe('sessions')
    expect(s.resourceId).toBe('sess1')
  })

  it('returns file for sessions/<id>/<traceId>.json', () => {
    const s = detectScope('sessions/sess1/trace1.json')
    expect(s.level).toBe('file')
    expect(s.resourceType).toBe('sessions')
    expect(s.resourceId).toBe('sess1')
    expect(s.subResource).toBe('trace1.json')
  })

  it('returns file for prompts/<name>/<version>.json', () => {
    const s = detectScope('prompts/my-prompt/1.json')
    expect(s.level).toBe('file')
    expect(s.resourceType).toBe('prompts')
    expect(s.resourceId).toBe('my-prompt')
    expect(s.subResource).toBe('1.json')
  })

  it('returns file for datasets/<name>/items.jsonl', () => {
    const s = detectScope('datasets/my-dataset/items.jsonl')
    expect(s.level).toBe('file')
    expect(s.resourceType).toBe('datasets')
    expect(s.resourceId).toBe('my-dataset')
    expect(s.subResource).toBe('items.jsonl')
  })

  it('returns file for datasets/<name>/runs/<run>.jsonl', () => {
    const s = detectScope('datasets/my-dataset/runs/run1.jsonl')
    expect(s.level).toBe('file')
    expect(s.resourceType).toBe('datasets')
    expect(s.resourceId).toBe('my-dataset')
    expect(s.subResource).toBe('run1.jsonl')
  })
})

describe('langfuse detectScope fallback', () => {
  it('classifies an unrecognized path as unknown, not root', () => {
    // Falling back to 'root' made the grep/rg push-down treat any bogus path
    // as "search every trace", answering a missing file with the whole mount.
    expect(detectScope('__nf_missing__').level).toBe('unknown')
    expect(detectScope('traces/a/b/c/d').level).toBe('unknown')
  })
})
