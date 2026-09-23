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
import { PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { SEARCH_KINDS, detectScope } from './scope.ts'

// A mount-relative operand, the way a command hands one to a scope.
// detectScope declares PathSpec and reads only mountPath; passing the bare
// string relied on its string fallback, which is the raw-string path
// CLAUDE.md forbids.
function spec(path: string): PathSpec {
  const key = path.replace(/^\/+|\/+$/g, '')
  return new PathSpec({
    vfsPath: key,
    virtual: `/langfuse/${key}`,
    directory: '/langfuse',
    pattern: null,
    resolved: true,
  })
}

describe('langfuse detectScope', () => {
  it('classifies the root path', () => {
    expect(detectScope(spec('/')).kind).toBe('root')
  })

  it('classifies the traces dir', () => {
    expect(detectScope(spec('/traces')).kind).toBe('traces')
  })

  it('classifies a trace file', () => {
    const match = detectScope(spec('/traces/abc.json'))
    expect(match.kind).toBe('trace')
    expect(match.slots).toEqual({ trace_id: 'abc' })
  })

  it('classifies the sessions dir', () => {
    expect(detectScope(spec('/sessions')).kind).toBe('sessions')
  })

  it('classifies a session id', () => {
    const match = detectScope(spec('/sessions/sid1'))
    expect(match.kind).toBe('session')
    expect(match.slots).toEqual({ session_id: 'sid1' })
  })

  it('classifies a session trace file', () => {
    const match = detectScope(spec('/sessions/sid1/tid1.json'))
    expect(match.kind).toBe('session_trace')
    expect(match.slots).toEqual({ session_id: 'sid1', trace_id: 'tid1' })
  })

  it('classifies the prompts dir', () => {
    expect(detectScope(spec('/prompts')).kind).toBe('prompts')
  })

  it('classifies a prompt name', () => {
    const match = detectScope(spec('/prompts/summarize'))
    expect(match.kind).toBe('prompt')
    expect(match.slots).toEqual({ prompt_name: 'summarize' })
  })

  it('classifies a prompt version file', () => {
    const match = detectScope(spec('/prompts/summarize/1.json'))
    expect(match.kind).toBe('prompt_version')
    expect(match.slots).toEqual({ prompt_name: 'summarize', version: '1' })
  })

  it('requires a prompt version to be an integer', () => {
    // int("abc") used to crash the python read path; a non-numeric version
    // now fails the scope match and reads as ENOENT in both languages.
    expect(detectScope(spec('/prompts/summarize/abc.json')).kind).toBe('invalid')
  })

  it('classifies the datasets dir', () => {
    expect(detectScope(spec('/datasets')).kind).toBe('datasets')
  })

  it('classifies a dataset name', () => {
    const match = detectScope(spec('/datasets/qa-eval'))
    expect(match.kind).toBe('dataset')
    expect(match.slots).toEqual({ dataset_name: 'qa-eval' })
  })
})

describe('langfuse detectScope glob specs', () => {
  it('classifies a glob-scope root', () => {
    const gs = new PathSpec({
      vfsPath: mountKey('/langfuse/', '/langfuse'),
      virtual: '/langfuse/',
      directory: '/langfuse/',
      pattern: null,
      resolved: false,
    })
    expect(detectScope(gs).kind).toBe('root')
  })

  it('classifies a glob-scope traces dir', () => {
    const gs = new PathSpec({
      vfsPath: mountKey('/langfuse/traces', '/langfuse'),
      virtual: '/langfuse/traces',
      directory: '/langfuse/',
      pattern: null,
      resolved: false,
    })
    expect(detectScope(gs).kind).toBe('traces')
  })

  it('classifies a glob-resolved file', () => {
    const gs = new PathSpec({
      vfsPath: mountKey('/langfuse/traces/abc.json', '/langfuse'),
      virtual: '/langfuse/traces/abc.json',
      directory: '/langfuse/traces/',
      pattern: '*.json',
      resolved: true,
    })
    const match = detectScope(gs)
    expect(match.kind).toBe('trace')
    expect(match.slots).toEqual({ trace_id: 'abc' })
  })
})

describe('langfuse search push-down classification', () => {
  it('classifies an unrecognized path as invalid, not root', () => {
    // Falling back to "root" made the grep/rg push-down treat any bogus path
    // as "search every trace", answering a missing file with the whole mount.
    expect(detectScope(spec('__nf_missing__')).kind).toBe('invalid')
    expect(detectScope(spec('traces/a/b/c/d')).kind).toBe('invalid')
    expect(Object.hasOwn(SEARCH_KINDS, 'invalid')).toBe(false)
  })

  it('lets leaves fall through the search push-down', () => {
    // A leaf path must reach the generic per-file scan, never a
    // whole-container search.
    for (const path of [
      '/traces/abc.json',
      '/datasets/qa/items.jsonl',
      '/datasets/qa/runs',
      '/datasets/qa/runs/r1.jsonl',
    ]) {
      expect(Object.hasOwn(SEARCH_KINDS, detectScope(spec(path)).kind)).toBe(false)
    }
  })
})
