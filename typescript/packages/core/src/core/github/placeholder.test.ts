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
import { expand } from './placeholder.ts'
import type { GhConfig } from './config.ts'

const CONFIG = { token: 't', repo: 'acme/tools', branch: 'main' } as unknown as GhConfig

describe('gh placeholders', () => {
  it('expands the three gh documents', () => {
    expect(expand('repos/{owner}/{repo}/branches/{branch}', CONFIG)).toBe(
      'repos/acme/tools/branches/main',
    )
  })

  it('leaves a path with no braces untouched', () => {
    expect(expand('/user', CONFIG)).toBe('/user')
  })

  // gh leaves an unknown placeholder alone and lets the request go out; the
  // API answers 404 for the literal segment. Probed against gh 2.85, which
  // returns GitHub's own Not Found rather than a client-side error.
  it('leaves an unknown placeholder on the wire', () => {
    expect(expand('repos/{owner}/{nope}', CONFIG)).toBe('repos/acme/{nope}')
  })

  it('reads the owner off a host-qualified repo', () => {
    const config = { token: 't', repo: 'github.com/acme/tools' } as unknown as GhConfig
    expect(expand('repos/{owner}/{repo}', config)).toBe('repos/acme/tools')
  })

  it('refuses owner when the install names no repository', () => {
    const config = { token: 't' } as unknown as GhConfig
    expect(() => expand('repos/{owner}/x', config)).toThrow(/unable to expand placeholder/)
  })

  // `branch` is its own field: an install may name a repository without
  // pinning a branch, and gh reports the failure rather than guessing one.
  it('refuses branch when the install pins none', () => {
    const config = { token: 't', repo: 'acme/tools' } as unknown as GhConfig
    expect(() => expand('repos/{owner}/{repo}/branches/{branch}', config)).toThrow(
      /no `branch` on the install/,
    )
  })
})
