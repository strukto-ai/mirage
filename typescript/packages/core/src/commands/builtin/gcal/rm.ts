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

import { unlink } from '../../../core/gcal/unlink.ts'
import { ResourceName } from '../../../types.ts'
import { makeRm } from '../generic/rm_command.ts'
import { GCAL_IO } from './io.ts'

export const GCAL_RM = makeRm(ResourceName.GCAL, GCAL_IO, unlink)
