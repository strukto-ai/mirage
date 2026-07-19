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

import { Accessor } from './base.ts'
import type { DropboxTokenManager } from '../core/dropbox/_client.ts'

/**
 * Normalize a subfolder-mount root to the Dropbox API convention:
 * `''` for the account root (the API rejects `'/'`), otherwise
 * `/seg/seg` with no trailing slash.
 */
export function normalizeDropboxRootPath(value: string | undefined): string {
  const parts = (value ?? '').split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) {
    throw new Error("rootPath must not contain '..' segments")
  }
  return parts.length === 0 ? '' : '/' + parts.join('/')
}

export class DropboxAccessor extends Accessor {
  readonly tokenManager: DropboxTokenManager
  readonly rootPath: string
  // Opt-in for grep/rg search push-down; full-text content search is
  // plan-gated on Dropbox, so this must mirror the account's plan.
  readonly contentSearch: boolean

  constructor(opts: {
    tokenManager: DropboxTokenManager
    rootPath?: string
    contentSearch?: boolean
  }) {
    super()
    this.tokenManager = opts.tokenManager
    this.rootPath = normalizeDropboxRootPath(opts.rootPath)
    this.contentSearch = opts.contentSearch === true
  }
}
