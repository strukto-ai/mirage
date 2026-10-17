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

export const PROMPT = `{prefix}
  workspaces/
    <workspace-name>__<workspace-id>/
      workspace.json
      boards/
        <board-name>__<board-id>/
          board.json
          members/
            <full-name>__<member-id>.json
          labels/
            <label-name>__<label-id>.json
          lists/
            <list-name>__<list-id>/
              list.json
              cards/
                <card-name>__<card-id>/
                  card.json
                  comments.jsonl
  Always ls directories first to discover exact names.

  To act on boards and cards (list boards, members, lists, labels,
  cards and comments; create, update, move, assign, label and comment
  on cards), use the trello CLI if installed: trello --help`

export const WRITE_PROMPT = `  Writes go through the trello CLI if installed:
    trello card create --list_id <list-id> --name <name>
    trello card comment --card_id <card-id> --text <text>
  See trello --help for every verb.`
