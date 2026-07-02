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

import type { HistoryAccessor } from '../../../accessor/history.ts'
import { find as histFind } from '../../../core/history/find.ts'
import { readdir as histReaddir } from '../../../core/history/readdir.ts'
import { stat as histStat } from '../../../core/history/stat.ts'
import { stream as histStream } from '../../../core/history/stream.ts'
import { ResourceName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { command } from '../../config.ts'
import { withDefaultProvisions } from '../generic_bind/provision.ts'
import { specOf } from '../../spec/builtins.ts'
import { concatAggregate, headerAggregate, prefixAggregate, wcAggregate } from '../aggregators.ts'
import { catGeneric } from '../generic/cat.ts'
import { findGeneric } from '../generic/find.ts'
import { grepGeneric } from '../generic/grep.ts'
import { headGeneric } from '../generic/head.ts'
import { lsGeneric } from '../generic/ls.ts'
import { rgGeneric } from '../generic/rg.ts'
import { statGeneric } from '../generic/stat.ts'
import { tailGeneric } from '../generic/tail.ts'
import { treeGeneric } from '../generic/tree.ts'
import { wcGeneric } from '../generic/wc.ts'
import { HISTORY_HISTORY } from './history_cmd.ts'

const R = ResourceName.HISTORY

const HISTORY_CAT = command({
  name: 'cat',
  resource: R,
  spec: specOf('cat'),
  fn: (a: HistoryAccessor, paths, texts, opts) =>
    catGeneric(
      paths,
      texts,
      opts,
      (p) => histStat(a, p),
      (p) => histStream(a, p),
    ),
  aggregate: concatAggregate,
})

const HISTORY_GREP = command({
  name: 'grep',
  resource: R,
  spec: specOf('grep'),
  fn: (a: HistoryAccessor, paths, texts, opts) =>
    grepGeneric(
      'grep',
      paths,
      texts,
      opts,
      (p) => histStat(a, p),
      (p) => histReaddir(a, p),
      (p) => histStream(a, p),
    ),
  aggregate: prefixAggregate,
})

const HISTORY_RG = command({
  name: 'rg',
  resource: R,
  spec: specOf('rg'),
  fn: (a: HistoryAccessor, paths, texts, opts) =>
    rgGeneric(
      paths,
      texts,
      opts,
      (p) => histStat(a, p),
      (p) => histReaddir(a, p),
      (p) => histStream(a, p),
    ),
  aggregate: prefixAggregate,
})

const HISTORY_HEAD = command({
  name: 'head',
  resource: R,
  spec: specOf('head'),
  fn: (a: HistoryAccessor, paths, texts, opts) =>
    headGeneric(
      paths,
      texts,
      opts,
      (p) => histStat(a, p),
      (p) => histStream(a, p),
    ),
  aggregate: headerAggregate,
})

const HISTORY_TAIL = command({
  name: 'tail',
  resource: R,
  spec: specOf('tail'),
  fn: (a: HistoryAccessor, paths, texts, opts) =>
    tailGeneric(paths, texts, opts, (p) => histStream(a, p)),
  aggregate: headerAggregate,
})

const HISTORY_WC = command({
  name: 'wc',
  resource: R,
  spec: specOf('wc'),
  fn: (a: HistoryAccessor, paths, texts, opts) =>
    wcGeneric(paths, texts, opts, (p) => histStream(a, p)),
  aggregate: wcAggregate,
})

const HISTORY_LS = command({
  name: 'ls',
  resource: R,
  spec: specOf('ls'),
  fn: (a: HistoryAccessor, paths, _texts, opts) =>
    lsGeneric(
      paths,
      opts,
      (p) => histReaddir(a, p),
      (p) => histStat(a, p),
    ),
})

const HISTORY_STAT = command({
  name: 'stat',
  resource: R,
  spec: specOf('stat'),
  fn: (a: HistoryAccessor, paths, _texts, opts) => statGeneric(paths, opts, (p) => histStat(a, p)),
})

const HISTORY_TREE = command({
  name: 'tree',
  resource: R,
  spec: specOf('tree'),
  fn: (a: HistoryAccessor, paths, _texts, opts) =>
    treeGeneric(
      paths,
      opts,
      (p) => histReaddir(a, p),
      (p) => histStat(a, p),
    ),
})

const HISTORY_FIND = command({
  name: 'find',
  resource: R,
  spec: specOf('find'),
  fn: (a: HistoryAccessor, paths, texts, opts) =>
    findGeneric(paths, texts, opts, (root, options) => histFind(a, root, options)),
})

// The rendered histfile stats with a real size, so the shared family
// defaults give exact estimates over the view mount.
export const HISTORY_COMMANDS: readonly RegisteredCommand[] = withDefaultProvisions(
  [
    ...HISTORY_CAT,
    ...HISTORY_GREP,
    ...HISTORY_RG,
    ...HISTORY_HEAD,
    ...HISTORY_TAIL,
    ...HISTORY_WC,
    ...HISTORY_LS,
    ...HISTORY_STAT,
    ...HISTORY_TREE,
    ...HISTORY_FIND,
    ...HISTORY_HISTORY,
  ],
  histStat,
)
