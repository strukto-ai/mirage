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

import { ContentType, FileType } from '../../types.ts'
import { entryStat, makeStat } from '../hierarchy/stat.ts'
import { readdir } from './readdir.ts'
import { detectScope } from './scope.ts'

export const stat = makeStat(detectScope, readdir, {
  entryStats: {
    workspace: entryStat('workspace_id', FileType.DIRECTORY),
    workspace_json: entryStat('workspace_id', ContentType.JSON),
    board: entryStat('board_id', FileType.DIRECTORY),
    board_json: entryStat('board_id', ContentType.JSON),
    member: entryStat('member_id', ContentType.JSON),
    label: entryStat('label_id', ContentType.JSON),
    list: entryStat('list_id', FileType.DIRECTORY),
    list_json: entryStat('list_id', ContentType.JSON),
    card: entryStat('card_id', FileType.DIRECTORY),
    card_json: entryStat('card_id', ContentType.JSON),
    comments_jsonl: entryStat('card_id', ContentType.TEXT),
  },
})
