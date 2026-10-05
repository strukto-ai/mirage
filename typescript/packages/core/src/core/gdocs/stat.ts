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

import { makeAppStat } from '../google/stat.ts'
import { makeFilename } from '../../vfs/gdocs/doc_entry.ts'
import { MIME } from './constants.ts'
import { readdir } from './readdir.ts'
import { detectScope } from './scope.ts'

export const stat = makeAppStat(MIME, detectScope, readdir, 'gdocs/file', makeFilename)
