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

import type { S3Accessor } from '../../../accessor/s3.ts'
import { VFSName } from '../../../types.ts'
import { CommandCatalog } from '../../config.ts'
import { resolveGlobOf } from '../generic_bind/adapter.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { withDefaultProvisions } from '../generic_bind/provision.ts'
import { makeObjectStoreCommands, OBJECT_STORE_OVERRIDES } from '../object_store/index.ts'
import { S3_IO } from './io.ts'

export const S3_COMMANDS = new CommandCatalog([
  ...makeGenericCommands<S3Accessor>(VFSName.S3, S3_IO, {
    overrides: OBJECT_STORE_OVERRIDES,
  }),
  ...withDefaultProvisions(
    makeObjectStoreCommands(VFSName.S3, S3_IO),
    S3_IO.stat,
    resolveGlobOf(S3_IO),
    S3_IO.readdir,
  ),
])
