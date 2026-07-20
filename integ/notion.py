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
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cases import run_not_found, run_provision_probe, run_sed_readonly_probe

from mirage import MountMode, Workspace
from mirage.resource.notion import NotionConfig, NotionResource

MOUNT = "/notion"
PAGE_A = "aaaa1111-2222-3333-4444-555566667777"
PAGE_B = "bbbb2222-3333-4444-5555-666677778888"
PAGE_C = "cccc1111-2222-3333-4444-555566667777"
BLOCK_NESTED = "dddd2222-3333-4444-5555-666677778888"
DB_TASKS = "eeee1111-2222-3333-4444-555566667777"
ROW_1 = "ffff1111-2222-3333-4444-555566667777"
ROW_2 = "ffff2222-3333-4444-5555-666677778888"
DIR_A = f"{MOUNT}/pages/Project_Roadmap__{PAGE_A}"
DIR_B = f"{MOUNT}/pages/Notes__{PAGE_B}"
DIR_C = f"{DIR_A}/Q1_Goals__{PAGE_C}"
DB_DIR = f"{MOUNT}/databases/Tasks__{DB_TASKS}"
ROW_1_DIR = f"{DB_DIR}/Write_spec__{ROW_1}"


def _user(uid: str) -> dict:
    return {"object": "user", "id": uid}


def _title_prop(title: str) -> dict:
    return {
        "title": {
            "id":
            "title",
            "type":
            "title",
            "title": [{
                "type": "text",
                "plain_text": title,
                "text": {
                    "content": title
                },
            }],
        }
    }


def _page(page_id: str, title: str, parent: dict) -> dict:
    return {
        "object": "page",
        "id": page_id,
        "created_time": "2026-01-01T00:00:00.000Z",
        "last_edited_time": "2026-01-02T00:00:00.000Z",
        "created_by": _user("user-1"),
        "last_edited_by": _user("user-2"),
        "parent": parent,
        "archived": False,
        "url": f"https://notion.example/{page_id.replace('-', '')}",
        "properties": _title_prop(title),
    }


def _database(database_id: str, title: str) -> dict:
    return {
        "object":
        "database",
        "id":
        database_id,
        "created_time":
        "2026-01-01T00:00:00.000Z",
        "last_edited_time":
        "2026-01-02T00:00:00.000Z",
        "parent": {
            "type": "workspace",
            "workspace": True
        },
        "archived":
        False,
        "is_inline":
        False,
        "url":
        f"https://notion.example/{database_id.replace('-', '')}",
        "title": [{
            "type": "text",
            "plain_text": title,
            "text": {
                "content": title
            },
        }],
        "properties": {
            "Name": {
                "id": "title",
                "name": "Name",
                "type": "title",
                "title": {}
            },
            "Priority": {
                "id": "pri",
                "name": "Priority",
                "type": "number",
                "number": {
                    "format": "number"
                },
            },
        },
    }


def _text(content: str, **annotations: bool) -> dict:
    return {
        "type": "text",
        "plain_text": content,
        "annotations": annotations,
        "text": {
            "content": content
        },
    }


def _block(block_id: str,
           btype: str,
           payload: dict,
           *,
           has_children: bool = False) -> dict:
    return {
        "object": "block",
        "id": block_id,
        "type": btype,
        "has_children": has_children,
        btype: payload,
    }


PAGES = {
    PAGE_A:
    _page(PAGE_A, "Project Roadmap", {
        "type": "workspace",
        "workspace": True
    }),
    PAGE_B:
    _page(PAGE_B, "Notes", {
        "type": "workspace",
        "workspace": True
    }),
    PAGE_C:
    _page(PAGE_C, "Q1 Goals", {
        "type": "page_id",
        "page_id": PAGE_A
    }),
}

BLOCKS = {
    PAGE_A: [
        _block("b-a1", "heading_1", {"rich_text": [_text("Roadmap")]}),
        _block(
            "b-a2", "paragraph", {
                "rich_text": [
                    _text("Ship the "),
                    _text("beta", bold=True),
                    _text(" soon"),
                ]
            }),
        _block(BLOCK_NESTED,
               "bulleted_list_item", {"rich_text": [_text("phase one")]},
               has_children=True),
        _block("b-a4", "code", {
            "rich_text": [_text("print(1)")],
            "language": "python"
        }),
        _block(PAGE_C, "child_page", {"title": "Q1 Goals"}, has_children=True),
    ],
    PAGE_B: [
        _block("b-b1", "paragraph",
               {"rich_text": [_text("alpha beta gamma")]}),
        _block("b-b2", "to_do", {
            "rich_text": [_text("done item")],
            "checked": True
        }),
    ],
    PAGE_C: [
        _block("b-c1", "paragraph", {"rich_text": [_text("Q1 contents")]}),
    ],
    BLOCK_NESTED: [
        _block("b-d1", "bulleted_list_item",
               {"rich_text": [_text("phase one detail")]}),
    ],
}

DATABASES = {
    DB_TASKS: _database(DB_TASKS, "Tasks"),
}

DB_ROWS = {
    DB_TASKS: [
        _page(ROW_1, "Write spec", {
            "type": "database_id",
            "database_id": DB_TASKS
        }),
        _page(ROW_2, "Ship beta", {
            "type": "database_id",
            "database_id": DB_TASKS
        }),
    ],
}

ROW_PAGES = {row["id"]: row for rows in DB_ROWS.values() for row in rows}


class NotionMockHandler(BaseHTTPRequestHandler):

    def log_message(self, *args: object) -> None:
        pass

    def _send_json(self, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parts = self.path.split("?")[0].strip("/").split("/")
        if len(parts) == 3 and parts[0] == "v1" and parts[1] == "pages":
            page = PAGES.get(parts[2]) or ROW_PAGES.get(parts[2])
            if page is not None:
                self._send_json(page)
                return
        if len(parts) == 3 and parts[0] == "v1" and parts[1] == "databases":
            database = DATABASES.get(parts[2])
            if database is not None:
                self._send_json(database)
                return
        if (len(parts) == 4 and parts[0] == "v1" and parts[1] == "blocks"
                and parts[3] == "children"):
            blocks = BLOCKS.get(parts[2], [])
            self._send_json({
                "object": "list",
                "results": blocks,
                "has_more": False,
                "next_cursor": None,
            })
            return
        self.send_response(404)
        self.end_headers()

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        return json.loads(raw) if raw else {}

    def do_POST(self) -> None:
        parts = self.path.split("?")[0].strip("/").split("/")
        body = self._read_body()
        if len(parts) == 2 and parts[0] == "v1" and parts[1] == "search":
            is_database = body.get("filter", {}).get("value") == "database"
            results = (list(DATABASES.values())
                       if is_database else list(PAGES.values()))
            self._send_json({
                "object": "list",
                "results": results,
                "has_more": False,
                "next_cursor": None,
            })
            return
        if (len(parts) == 4 and parts[0] == "v1" and parts[1] == "databases"
                and parts[3] == "query"):
            self._send_json({
                "object": "list",
                "results": DB_ROWS.get(parts[2], []),
                "has_more": False,
                "next_cursor": None,
            })
            return
        self.send_response(404)
        self.end_headers()


CASES: list[tuple[str, str]] = [
    ("ls_root", f"ls {MOUNT}/"),
    ("ls_pages", f"ls {MOUNT}/pages/"),
    ("ls_l_pages", f"ls -l {MOUNT}/pages/"),
    ("ls_page_a", f"ls {DIR_A}/"),
    ("stat_dir_a", f"stat -c '%n %y' {DIR_A}"),
    ("cat_page_a", f"cat {DIR_A}/page.json"),
    ("cat_child", f"cat {DIR_C}/page.json"),
    ("jq_title", f'jq ".title" {DIR_A}/page.json'),
    ("jq_markdown", f'jq ".markdown" {DIR_B}/page.json'),
    ("head_4", f"head -n 4 {DIR_A}/page.json"),
    ("wc_l_two", f"wc -l {DIR_A}/page.json {DIR_B}/page.json"),
    ("stat_page_json", f"stat {DIR_A}/page.json"),
    ("find_json", f"find {MOUNT}/pages/ -name page.json"),
    ("find_root_maxdepth0", f"find {MOUNT} -maxdepth 0"),
    ("find_root_name", f"find {MOUNT} -name notion"),
    ("pipe_grep", f"cat {DIR_B}/page.json | grep -c alpha"),
    ("grep_file", f"grep -n alpha {DIR_B}/page.json"),
    ("grep_multi", f"grep -c alpha {DIR_A}/page.json {DIR_B}/page.json"),
    ("grep_recursive", f"grep -rl alpha {MOUNT}/pages/"),
    ("realpath_dotdot", f"realpath -e {DIR_C}/../page.json"),
    ("ls_databases", f"ls {MOUNT}/databases/"),
    ("ls_database_dir", f"ls {DB_DIR}/"),
    ("cat_database_json", f"cat {DB_DIR}/database.json"),
    ("jq_db_props", f'jq ".properties | keys" {DB_DIR}/database.json'),
    ("cat_row", f"cat {ROW_1_DIR}/page.json"),
    ("du_pages", f"du {MOUNT}/pages/"),
    ("du_page_a", f"du {DIR_A}/"),
]

EXIT_CODE_CASES: list[tuple[str, str]] = [
    ("grep_c_match_exit", f"grep -c alpha {DIR_B}/page.json"),
    ("grep_c_no_match_exit", f"grep -c zzz {DIR_B}/page.json"),
    ("grep_rc_no_match_exit", f"grep -rc zzz {MOUNT}/pages/"),
]


async def _run(ws: Workspace, name: str, cmd: str) -> None:
    result = await ws.execute(cmd)
    out = await result.stdout_str()
    print(f"=== {name} ===")
    print(out, end="" if out.endswith("\n") else "\n")


async def _run_exit(ws: Workspace, name: str, cmd: str) -> None:
    result = await ws.execute(cmd)
    out = await result.stdout_str()
    print(f"=== {name} ===")
    print(f"exit={result.exit_code}")
    if out:
        print(out, end="" if out.endswith("\n") else "\n")


async def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), NotionMockHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    try:
        config = NotionConfig(api_key="integ-test",
                              base_url=f"http://127.0.0.1:{port}/v1")
        resource = NotionResource(config=config)
        ws = Workspace({MOUNT: resource}, mode=MountMode.READ)
        for name, cmd in CASES:
            await _run(ws, name, cmd)
        for name, cmd in EXIT_CODE_CASES:
            await _run_exit(ws, name, cmd)
        await run_not_found(ws, MOUNT)
        await run_provision_probe(ws, f"{DIR_A}/page.json")
        await run_sed_readonly_probe(ws, f"{DIR_A}/page.json")
    finally:
        server.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
