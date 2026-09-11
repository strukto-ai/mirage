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


async def main():
    with Workspace({"/trello/": resource}, mode=MountMode.READ) as ws:
        print("=== VFS MODE ===\n")

        print("--- os.listdir() root ---")
        entries = os.listdir("/trello")
        for e in entries:
            print(f"  {e}")

        print("\n--- os.listdir() workspaces ---")
        workspaces = os.listdir("/trello/workspaces")
        for w in workspaces[:5]:
            print(f"  {w}")

        if workspaces:
            workspace = workspaces[0]
            ws_path = f"/trello/workspaces/{workspace}"

            print(f"\n--- os.listdir() {workspace} ---")
            contents = os.listdir(ws_path)
            for c in contents:
                print(f"  {c}")

            print("\n--- open() workspace.json ---")
            with open(f"{ws_path}/workspace.json") as f:
                data = json.loads(f.read())
                print(f"  name: {data.get('workspace_name')}")
                print(f"  id: {data.get('workspace_id')}")

            boards_path = f"{ws_path}/boards"
            if os.path.isdir(boards_path):
                boards = os.listdir(boards_path)
                print(f"\n--- os.listdir() boards ({len(boards)}) ---")
                for b in boards[:5]:
                    print(f"  {b}")

                if boards:
                    board_dir = f"{boards_path}/{boards[0]}"
                    print("\n--- open() board.json ---")
                    with open(f"{board_dir}/board.json") as f:
                        data = json.loads(f.read())
                        print(f"  name: {data.get('board_name')}")
                        print(f"  id: {data.get('board_id')}")

                    lists_path = f"{board_dir}/lists"
                    if os.path.isdir(lists_path):
                        lists = os.listdir(lists_path)
                        print(f"\n--- os.listdir() lists ({len(lists)}) ---")
                        for li in lists[:5]:
                            print(f"  {li}")

                        if lists:
                            list_dir = f"{lists_path}/{lists[0]}"
                            cards_path = f"{list_dir}/cards"
                            if os.path.isdir(cards_path):
                                cards = os.listdir(cards_path)
                                msg = (f"\n--- os.listdir() "
                                       f"cards ({len(cards)}) ---")
                                print(msg)
                                for cd in cards[:5]:
                                    print(f"  {cd}")

                                if cards:
                                    card_dir = f"{cards_path}/{cards[0]}"
                                    print("\n--- open() card.json ---")
                                    with open(f"{card_dir}/card.json") as f:
                                        data = json.loads(f.read())
                                        print(
                                            f"  name: {data.get('card_name')}")
                                        print(f"  id: {data.get('card_id')}")
                                        print(
                                            f"  list_id: {data.get('list_id')}"
                                        )

        records = ws.fs.records
        total = sum(r.bytes for r in records)
        print(f"\nStats: {len(records)} ops, {total} bytes")


asyncio.run(main())
