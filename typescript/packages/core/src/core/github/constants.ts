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

export const SCOPE_WARN = 100
// GitHub's code search does not index a file at or over this size.
export const CODE_SEARCH_SIZE_LIMIT = 384 * 1024
// The largest page code search serves.
export const SEARCH_PAGE_SIZE = 100
// Each file is one request, so a walk may cost thousands of them.
export const WALK_LIMIT = 5000
// A point request answering these did not see the parent directory: it is
// missing, the ref is gone, the repository is hidden (GitHub answers 404 for
// all three) or a component of the path is a file (422). None of them is an
// answer about the file, so the caller asks the whole tree instead, where a
// real absence is honest and a refusal raises.
export const DEFER_STATUSES: ReadonlySet<number> = new Set([404, 422])
// The endpoint gh names GraphQL by (`gh api graphql`), which the transport
// sends to the install's GraphQL endpoint (`graphqlUrl`) instead of under
// its REST base. A REST path always leads with a slash, so `gh api
// /graphql` stays a REST call, as gh's `p == "graphql"` has it.
export const GRAPHQL_PATH = 'graphql'
// A full commit sha, SHA-1 or SHA-256, as GitHub answers it (lowercase). A
// mount whose ref matches is pinned to a commit that cannot move.
export const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
export const RAW_MEDIA_TYPE = 'application/vnd.github.raw+json'
