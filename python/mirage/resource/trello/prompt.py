# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

PROMPT = """\
{prefix}
  workspaces/
    <workspace-name>__<workspace-id>/
      workspace.json
      boards/
        <board-name>__<board-id>/
          board.json
          lists/
            <list-name>__<list-id>/
              list.json
              cards/
                <card-name>__<card-id>/
                  card.json
                  comments.jsonl
  Always ls directories first to discover exact names.

  Read commands (nested names, mirror the trello CLI; every command emits
  normalized JSON to stdout so you can pipe to jq):
    trello board list                       # all boards
    trello board show <board-id>
    trello board members <board-id>
    trello list list <board-id>             # lists on a board
    trello label list <board-id>
    trello card list <list-id>              # cards in a list
    trello card show <card-id>
    trello card comments <card-id>"""

WRITE_PROMPT = """\
  Write commands (nested names):
    trello card create <list-path> "name" "description"
    trello card update <card-path> [--name ...] [--desc ...]
    trello card move <card-path> --list_id <list-id>
    trello card assign <card-path> --member_id <member-id>
    trello card label <card-path> --label_id <label-id>
    trello card unlabel <card-path> --label_id <label-id>
    trello card comment <card-path> "comment"
    trello card comment-update --comment_id <comment-id> "comment" """
