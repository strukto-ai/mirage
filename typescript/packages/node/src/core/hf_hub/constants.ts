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

export const API_BASE = 'https://huggingface.co'

// The Hub's default branch. Unlike GitHub, where the default is per
// repository and costs a request to learn, every Hub repo is created with
// `main` and the API offers no way to change it, so an unpinned mount
// resolves without a round trip.
export const DEFAULT_REVISION = 'main'

export const SCOPE_ERROR = 5000

// The tree endpoint's page size, and the reason there are two of them.
// A bare listing serves up to 1000 rows a page. Asking for `expand=true`
// -- the only way to learn the commit that last touched each path, which
// is a Hub file's only mtime -- drops the server's own page to 50 and
// refuses any limit above 100 ("Invalid limit for index tree pagination").
// A 100k-file dataset is therefore ~100 requests bare and ~2000 expanded
// against a budget the Hub advertises as 500 calls / 300s, which is why
// expansion is opt-in per mount rather than the default.
export const TREE_PAGE_SIZE = 1000
export const TREE_PAGE_SIZE_EXPANDED = 100

// How many hops of `Link: rel="next"` a tree walk will follow. A repo of
// 100k files is 100 pages; the ceiling exists so a server that answers a
// self-referential cursor cannot spin forever.
export const MAX_TREE_PAGES = 1000

// The URL segment each repo type is addressed by under /api/. Both the
// API and the resolve host spell the plural, and this is also the
// `{repoType}s` the commit and preupload endpoints interpolate.
export const API_SEGMENTS: Record<string, string> = {
  model: 'models',
  dataset: 'datasets',
  space: 'spaces',
}

// The segment the *content* host spells, which is not the same table: a
// model's files hang off the bare repo id (huggingface.co/gpt2/resolve/...)
// while a dataset's and a space's sit under their own segment. Reusing
// API_SEGMENTS here 404s every model read.
export const RESOLVE_SEGMENTS: Record<string, string> = {
  model: '',
  dataset: 'datasets',
  space: 'spaces',
}

// How much of a file the preupload probe sends so the Hub can decide
// regular-vs-LFS. huggingface_hub sends the same 512 bytes.
export const PREUPLOAD_SAMPLE_BYTES = 512

// Statuses worth another attempt. 429 is the documented rate limit (the
// Hub advertises 500 API calls / 300s and 3000 resolves / 300s in
// `ratelimit` headers) and the 5xx family is transient by definition.
// The Hub answers a create for a repository that already exists with
// this, which is what --exist-ok turns back into success.
export const HTTP_CONFLICT = 409

export const RETRY_STATUSES = new Set([429, 500, 502, 503, 504])
export const MAX_RETRIES = 3

// How many files one preupload probe asks about. huggingface_hub chunks
// at the same 256.
export const COMMIT_CHUNK = 256

// Upstream's own default for `hf download --max-workers`. The bound is
// what matters: the Hub rate-limits its resolvers at 3000 per 300s, so a
// repository of many small files must not fan out without one.
export const MAX_DOWNLOAD_WORKERS = 8

// Upstream's separator for the flat per-repository cache directory
// (constants.REPO_ID_SEPARATOR): "models--julien-c--EsperBERTo-small".
export const REPO_ID_SEPARATOR = '--'

// What makes a word a pattern rather than a filename. Used to tell an
// upstream-style variadic --include line from a real filename operand.
export const GLOB_CHARS: readonly string[] = ['*', '?', '[']

// The file a deletion pattern never removes: the Hub reads its LFS rules from
// it, so upstream keeps it whatever `--delete` or `repo-files delete` matched.
export const GITATTRIBUTES = '.gitattributes'

// What upstream's upload_folder always leaves out of a folder upload
// (DEFAULT_IGNORE_PATTERNS): a git checkout's own metadata and the hub's local
// cache folder, wherever they sit in the tree.
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  '.git',
  '.git/*',
  '*/.git',
  '**/.git/**',
  '.cache/huggingface',
  '.cache/huggingface/*',
  '*/.cache/huggingface',
  '**/.cache/huggingface/**',
]

// What upstream's `create_commit` logs when a commit would change nothing, and
// then skips it rather than making an empty one.
export const EMPTY_COMMIT_WARNING =
  'No files have been modified since last commit. Skipping to prevent empty commit.\n'

// What a commit says when the caller had nothing to say. The Hub requires
// a non-empty summary, and a write reaching the backend through `cp` or a
// redirect has no message of its own to offer.
export const DEFAULT_COMMIT_MESSAGE = 'Update from mirage'

// The statuses a refused tree walk comes back with when the repository or
// revision cannot be seen (a first-page 404 EntryNotFound, a key_prefix naming
// no folder, lists empty before it gets here). A mount reports them as
// permission denied, which every file tool steps past; `hf download` alone
// folds them into an empty listing, so its failure path can ask the Hub which
// absence it was and name it in upstream's words.
export const ABSENT_STATUSES: ReadonlySet<number> = new Set([401, 403, 404])

// The statuses a download is refused with when the listing was allowed: a
// gated repo, or a token that expired after the tree loaded. A 404 there is one
// file gone, not the repo withheld, so it is not among them.
export const REFUSED_STATUSES: ReadonlySet<number> = new Set([401, 403])
