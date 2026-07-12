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

import asyncio
import json
import os

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.trello import TrelloConfig, TrelloResource

load_dotenv(".env.development")

config = TrelloConfig(
    api_key=os.environ["TRELLO_API_KEY"],
    api_token=os.environ["TRELLO_API_TOKEN"],
)
resource = TrelloResource(config=config)


async def main() -> None:
    ws = Workspace({"/trello": resource}, mode=MountMode.WRITE)

    print("=== not-found errors show the full virtual path ===")
    for cmd in ("cat /trello/__nf_missing__.txt",
                "head /trello/__nf_missing__.txt",
                "stat /trello/__nf_missing__.txt"):
        result = await ws.execute(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    print("=== ls /trello/workspaces/ ===")
    result = await ws.execute("ls /trello/workspaces/")
    print(await result.stdout_str())

    first_ws = (await result.stdout_str()).strip().splitlines()[0] if (
        await result.stdout_str()).strip() else ""
    if not first_ws:
        print("No workspaces available")
        return

    print(f"=== cat /trello/workspaces/{first_ws}/workspace.json ===")
    result = await ws.execute(
        f"cat /trello/workspaces/{first_ws}/workspace.json")
    print(await result.stdout_str())

    print(f"=== ls /trello/workspaces/{first_ws}/boards/ ===")
    board_result = await ws.execute(f"ls /trello/workspaces/{first_ws}/boards/"
                                    )
    print(await board_result.stdout_str())

    # ── glob expansion: the workspace segment is the pattern, the
    # literal tail keeps walking (lists workspaces once, then filters).
    print("=== echo /trello/workspaces/*/boards (mid-path glob) ===")
    result = await ws.execute("echo /trello/workspaces/*/boards")
    glob_out = (await result.stdout_str()).strip()
    print(f"  {glob_out[:200]}")
    assert glob_out.endswith("/boards"), "mid-path glob did not expand"

    # A glob that matches nothing stays the literal word, so the
    # command reports it like GNU coreutils.
    print("=== cat /trello/workspaces/zz-none-*/workspace.json ===")
    result = await ws.execute("cat /trello/workspaces/zz-none-*/workspace.json"
                              )
    glob_err = (await result.stderr_str()).strip()
    print(f"  exit={result.exit_code}  {glob_err[:120]}")
    assert result.exit_code == 1 and "zz-none-*" in glob_err

    print(f"=== ls -l /trello/workspaces/{first_ws}/boards/ "
          "(mtime from dateLastActivity) ===")
    long_boards = await ws.execute(
        f"ls -l /trello/workspaces/{first_ws}/boards/")
    print(await long_boards.stdout_str())

    first_board = (await
                   board_result.stdout_str()).strip().splitlines()[0] if (
                       await board_result.stdout_str()).strip() else ""
    if not first_board:
        print("No boards available")
        return

    board_path = f"/trello/workspaces/{first_ws}/boards/{first_board}"

    print(f"=== cat {board_path}/board.json ===")
    result = await ws.execute(f"cat {board_path}/board.json")
    print(await result.stdout_str())

    print(f"=== ls {board_path}/members/ ===")
    member_result = await ws.execute(f"ls {board_path}/members/")
    print(await member_result.stdout_str())

    print(f"=== ls {board_path}/labels/ ===")
    label_result = await ws.execute(f"ls {board_path}/labels/")
    print(await label_result.stdout_str())

    print(f"=== ls {board_path}/lists/ ===")
    list_result = await ws.execute(f"ls {board_path}/lists/")
    print(await list_result.stdout_str())

    all_lists = (await list_result.stdout_str()).strip().splitlines()
    if not all_lists:
        print("No lists available")
        return

    first_card = ""
    list_path = ""
    list_id = ""
    for lst in all_lists:
        lp = f"{board_path}/lists/{lst}"
        r = await ws.execute(f"ls {lp}/cards/")
        cards = (await r.stdout_str()).strip().splitlines()
        if cards and cards[0]:
            list_path = lp
            first_card = cards[0]
            break

    print(f"=== cat {list_path}/list.json ===")
    result = await ws.execute(f"cat {list_path}/list.json")
    print(await result.stdout_str())

    list_payload = json.loads(await result.stdout_str())
    list_id = list_payload.get("list_id", "")

    print(f"=== ls {list_path}/cards/ ===")
    card_result = await ws.execute(f"ls {list_path}/cards/")
    print(await card_result.stdout_str())

    if not first_card:
        print("No cards available")
        return

    card_path = f"{list_path}/cards/{first_card}"

    print("=== cat card.json ===")
    result = await ws.execute(f"cat {card_path}/card.json")
    print(await result.stdout_str())

    card_payload = json.loads(await result.stdout_str())
    card_payload.get("card_id", "")

    print("=== head -n 3 comments.jsonl ===")
    result = await ws.execute(f"head -n 3 {card_path}/comments.jsonl")
    print(await result.stdout_str())

    print("=== tail -n 1 comments.jsonl ===")
    result = await ws.execute(f"tail -n 1 {card_path}/comments.jsonl")
    print(await result.stdout_str())

    print("=== wc -l comments.jsonl ===")
    result = await ws.execute(f"wc -l {card_path}/comments.jsonl")
    print(await result.stdout_str())

    print("=== stat card.json ===")
    result = await ws.execute(f"stat {card_path}/card.json")
    print(await result.stdout_str())

    print("=== jq .card_id card.json ===")
    result = await ws.execute(f'jq ".card_id" {card_path}/card.json')
    print(await result.stdout_str())

    print("=== jq .list_id card.json ===")
    result = await ws.execute(f'jq ".list_id" {card_path}/card.json')
    print(await result.stdout_str())

    print("=== tree -L 1 /trello/ ===")
    result = await ws.execute("tree -L 1 /trello/")
    print(await result.stdout_str())

    print(f"=== tree -L 1 {board_path}/ ===")
    result = await ws.execute(f"tree -L 1 {board_path}/")
    print(await result.stdout_str())

    print("=== find cards -name '*.json' ===")
    result = await ws.execute(
        f'find {list_path}/cards/ -name "*.json" | head -n 5')
    print(await result.stdout_str())

    # -path matches the display path; -size counts dirs and sizeless
    # rendered files as 0 (so +0c drops them, -1k keeps them).
    print("=== find board -path '*cards*' ===")
    result = await ws.execute(f'find {board_path}/ -path "*cards*" | head -n 5'
                              )
    print(await result.stdout_str())

    print("=== find board -maxdepth 1 -size +0c (dirs drop out) ===")
    result = await ws.execute(f"find {board_path}/ -maxdepth 1 -size +0c")
    print(f"  exit={result.exit_code}")
    print(await result.stdout_str())

    print("=== find board -type d (directory filter) ===")
    result = await ws.execute(f"find {board_path}/ -type d | head -n 5")
    print(await result.stdout_str())

    print("=== du -s board (walk fallback) ===")
    result = await ws.execute(f"du -s {board_path}/")
    print(await result.stdout_str())

    ws_path = f"/trello/workspaces/{first_ws}"
    print("=== grep -r wawa across workspace ===")
    result = await ws.execute(f"grep -r wawa {ws_path}/")
    print(await result.stdout_str())

    print("=== grep on card.json ===")
    result = await ws.execute(f"grep card_id {card_path}/card.json")
    print(await result.stdout_str())

    print("=== rg on board.json ===")
    result = await ws.execute(f"rg board_id {board_path}/board.json")
    print(await result.stdout_str())

    print("=== basename ===")
    result = await ws.execute(f"basename {card_path}/card.json")
    print(await result.stdout_str())

    print("=== dirname ===")
    result = await ws.execute(f"dirname {card_path}/card.json")
    print(await result.stdout_str())

    print("=== realpath ===")
    result = await ws.execute(f"realpath {card_path}/card.json")
    print(await result.stdout_str())

    print("=== trello-card-create ===")
    result = await ws.execute(f'trello-card-create --list_id {list_id}'
                              ' --name "Test card from MIRAGE"'
                              ' --desc "Created by example script"')
    print(await result.stdout_str())

    new_card = json.loads(await result.stdout_str())
    new_card_id = new_card.get("card_id", "")

    print("=== trello-card-update ===")
    result = await ws.execute(
        f'trello-card-update --card_id {new_card_id}'
        ' --name "Updated test card" --desc "Updated description"')
    print(await result.stdout_str())

    print("=== trello-card-move ===")
    result = await ws.execute(
        f"trello-card-move --card_id {new_card_id} --list_id {list_id}")
    print(await result.stdout_str())

    members = (await member_result.stdout_str()).strip().splitlines()
    if members:
        first_member_name = members[0]
        member_id = first_member_name.rsplit("__", 1)[-1].replace(".json", "")
        print("=== trello-card-assign ===")
        result = await ws.execute(f"trello-card-assign --card_id {new_card_id}"
                                  f" --member_id {member_id}")
        print(await result.stdout_str())

    print("=== trello-card-comment-add ===")
    result = await ws.execute(
        f'trello-card-comment-add --card_id {new_card_id}'
        ' --text "Test comment from MIRAGE"')
    print(await result.stdout_str())

    comment_payload = json.loads(await result.stdout_str())
    comment_id = comment_payload.get("comment_id", "")

    print("=== trello-card-comment-update ===")
    result = await ws.execute(
        f"trello-card-comment-update --comment_id {comment_id}"
        f' --card_id {new_card_id} --text "Updated comment"')
    print(await result.stdout_str())

    labels = (await label_result.stdout_str()).strip().splitlines()
    if labels:
        first_label_name = labels[0]
        label_id = first_label_name.rsplit("__", 1)[-1].replace(".json", "")
        print("=== trello-card-label-add ===")
        result = await ws.execute(
            f"trello-card-label-add --card_id {new_card_id}"
            f" --label_id {label_id}")
        print(await result.stdout_str())

        print("=== trello-card-label-remove ===")
        result = await ws.execute(
            f"trello-card-label-remove --card_id {new_card_id}"
            f" --label_id {label_id}")
        print(await result.stdout_str())

    print("=== trello-card-update (archive) ===")
    result = await ws.execute(
        f"trello-card-update --card_id {new_card_id} --closed true")
    print(await result.stdout_str())


if __name__ == "__main__":
    asyncio.run(main())
