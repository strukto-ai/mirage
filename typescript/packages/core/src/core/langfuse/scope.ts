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

import { ContentType } from '../../types.ts'
import { INT_JSON, JSON_NAME, JSONL_NAME } from '../hierarchy/codec.ts'
import { Slot, Scope, makeDetectScope } from '../hierarchy/scope.ts'

export const TOP_LEVEL_DIRS = ['traces', 'sessions', 'prompts', 'datasets']

// One description of the tree: readdir, stat, read AND the grep/rg search
// push-down all classify through it, so the file surface and the search
// surface cannot disagree about what a path means (they used to be two
// hand-maintained dispatch ladders).
export const SCOPES: readonly Scope[] = [
  new Scope({ kind: 'traces', segments: ['traces'], probed: false }),
  new Scope({
    kind: 'trace',
    segments: ['traces', new Slot('trace_id', JSON_NAME)],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({ kind: 'sessions', segments: ['sessions'], probed: false }),
  new Scope({ kind: 'session', segments: ['sessions', new Slot('session_id')] }),
  new Scope({
    kind: 'session_trace',
    segments: ['sessions', new Slot('session_id'), new Slot('trace_id', JSON_NAME)],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({ kind: 'prompts', segments: ['prompts'], probed: false }),
  new Scope({ kind: 'prompt', segments: ['prompts', new Slot('prompt_name')] }),
  // A version that is not a plain ASCII integer cannot name a prompt version,
  // so it fails the scope match and reads as ENOENT instead of an int() crash
  // (python) or a digit-prefix guess (typescript).
  new Scope({
    kind: 'prompt_version',
    segments: ['prompts', new Slot('prompt_name'), new Slot('version', INT_JSON)],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({ kind: 'datasets', segments: ['datasets'], probed: false }),
  new Scope({ kind: 'dataset', segments: ['datasets', new Slot('dataset_name')] }),
  new Scope({
    kind: 'dataset_items',
    segments: ['datasets', new Slot('dataset_name'), 'items.jsonl'],
    leaf: true,
    filetype: ContentType.TEXT,
  }),
  new Scope({ kind: 'runs', segments: ['datasets', new Slot('dataset_name'), 'runs'] }),
  new Scope({
    kind: 'dataset_run',
    segments: ['datasets', new Slot('dataset_name'), 'runs', new Slot('run_name', JSONL_NAME)],
    leaf: true,
    filetype: ContentType.TEXT,
  }),
]

export const detectScope = makeDetectScope(SCOPES)

// The kinds the grep/rg push-down may answer with a whole-container search;
// leaves and unrecognized paths fall through to the generic per-file scan.
export const SEARCH_KINDS: Readonly<Record<string, string>> = {
  root: 'traces',
  traces: 'traces',
  sessions: 'sessions',
  session: 'sessions',
  prompts: 'prompts',
  prompt: 'prompts',
  datasets: 'datasets',
  dataset: 'datasets',
}
