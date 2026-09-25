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
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { makeStat } from '@struktoai/mirage-core/core/object_store/stat'
import type { FileStat, PathSpec } from '@struktoai/mirage-core/types'
import type { HfBucketsAccessor } from '../../accessor/hf.ts'
import { refusalsDenied } from '../hf_hub/lookup.ts'
import { DRIVER } from './driver.ts'

const kitStat = makeStat(DRIVER)

/**
 * Stat one path, a refused bucket reading as permission denied.
 *
 * paths-info answers a missing path with an empty list, never an error, so a
 * 401, 403 or 404 from it is about the bucket: an anonymous caller asking for
 * one that does not exist gets 401. Answering that as "no such file" would let
 * reconcile delete what a refreshed token can see.
 */
export async function stat(
  accessor: HfBucketsAccessor,
  pathSpec: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  return refusalsDenied(pathSpec, () => kitStat(accessor, pathSpec, index))
}
