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

import { parseConfig, schemaFor } from '../kit/typescript/index.ts'
import type { PrismaClient } from '../../generated/github/index.js'

export type C = PrismaClient

export const config = parseConfig({
  service: 'github',
  schema: schemaFor('github'),
  defaultPort: 5098,
  tenantKind: 'pk-column',
})

export const DEFAULT_BRANCH = 'main'
export const DEFAULT_LOGIN = 'integ-user'
// Every branch has a root commit, so "the latest commit" is answerable before
// anything is written. Its date is fixed rather than now, because a golden
// renders it.
export const ROOT_COMMIT_DATE = '1970-01-01T00:00:00Z'
// What an `author`/`committer` that names no date is dated. The vendor uses the
// current time; this uses a constant for the same reason ROOT_COMMIT_DATE does,
// and because a fake whose commits move with the wall clock cannot be the fixed
// point a benchmark compares against.
export const WRITE_COMMIT_DATE = '2026-01-01T00:00:00Z'
// A file at or over this size is not indexed for code search, which is
// GitHub's own documented limit.
export const SEARCH_SIZE_LIMIT = 384 * 1024
// The Enterprise mount serves every route a second time under this prefix.
export const API_PREFIXES = ['', '/api/v3']
