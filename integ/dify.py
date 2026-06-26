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
import re
import threading
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from cases import run_not_found

from mirage import MountMode, Workspace
from mirage.resource.dify import DifyConfig, DifyResource

DATASET_ID = "kb-7f3a"
MOUNT = "/knowledge/"
FIXED_UPDATED_AT = 1716282000

# Flat document list mirroring a Dify dataset, as (id, name, slug, size,
# segments) tuples. The slug maps a document to a virtual path; CHANGELOG.md
# has no slug and falls back to its name. Segments are the chunks Dify embeds;
# reading a file rejoins them with newlines, so segment order is line order.
DOCS: list[tuple[str, str, str | None, int, list[str]]] = [
    ("doc-quickstart", "Quickstart", "guides/quickstart", 180, [
        "Welcome to Acme. This quickstart gets you running fast.",
        "Install the CLI with npm i -g acme then run acme login.",
        "Set your token in the ACME_TOKEN environment variable.",
    ]),
    ("doc-auth", "Authentication", "guides/auth", 190, [
        "Authentication uses bearer tokens via the Authorization header.",
        "Requests are rate limited to 100 calls per minute per token.",
        "If you exceed the limit you receive HTTP 429 and must back off.",
    ]),
    ("doc-refunds", "Refund policy", "policies/refunds", 150, [
        "Refunds are available within 30 days of purchase.",
        "Email support to start a refund with your order id.",
        "Approved refunds are processed within five business days.",
    ]),
    ("doc-privacy", "Privacy policy", "policies/privacy", 120, [
        "Customer data is stored encrypted at rest and in transit.",
        "You may request deletion of your data at any time.",
    ]),
    ("doc-changelog", "CHANGELOG.md", None, 90, [
        "v2.0 added rate limit headers and refund automation.",
        "v1.5 introduced encrypted data exports.",
    ]),
]

DOC_BY_ID = {doc[0]: doc for doc in DOCS}

# Per-route hit counter so the index fast-path is observable: the first listing
# issues one GET /documents and populates the RAM index, after which a second
# listing reuses the index (list stays at 1). cat/grep/search are the commands
# that hit the network again.
API_CALLS: Counter = Counter()


def _document_summary(doc: tuple) -> dict:
    doc_id, name, slug, size, _segments = doc
    metadata = []
    if slug is not None:
        metadata = [{"name": "slug", "value": slug}]
    return {
        "id": doc_id,
        "name": name,
        "doc_metadata": metadata,
        "enabled": True,
        "indexing_status": "completed",
        "archived": False,
        "tokens": 8,
        "data_source_type": "upload_file",
        "data_source_detail_dict": {
            "upload_file": {
                "size": size
            }
        },
        "created_at": FIXED_UPDATED_AT,
    }


def _document_detail(doc: tuple) -> dict:
    detail = _document_summary(doc)
    detail["updated_at"] = FIXED_UPDATED_AT
    return detail


def _build_record(doc_id: str, content: str, score: float) -> dict:
    doc = DOC_BY_ID[doc_id]
    return {
        "segment": {
            "id": f"{doc_id}:{score:.2f}",
            "document_id": doc_id,
            "content": content,
            "document": {
                "id": doc[0],
                "data_source_type": "upload_file",
                "name": doc[1],
                "doc_type": None,
                "doc_metadata": _document_summary(doc)["doc_metadata"],
            },
        },
        "child_chunks": [],
        "score": score,
        "tsne_position": None,
        "files": [],
        "summary": None,
    }


def _retrieve_records(query: str) -> list[dict]:
    lowered = query.lower()
    if "throttl" in lowered or "rate" in lowered or "429" in lowered:
        return [
            _build_record(
                "doc-auth",
                "Requests are rate limited to 100 calls per minute per token.",
                0.92,
            ),
            _build_record(
                "doc-auth",
                ("If you exceed the limit you receive HTTP 429 and must "
                 "back off."),
                0.88,
            ),
        ]
    elif "refund" in lowered or "money" in lowered:
        return [
            _build_record(
                "doc-refunds",
                "Refunds are available within 30 days of purchase.",
                0.91,
            ),
            _build_record(
                "doc-refunds",
                "Approved refunds are processed within five business days.",
                0.84,
            ),
        ]
    elif "encrypt" in lowered or "privacy" in lowered:
        return [
            _build_record(
                "doc-privacy",
                "Customer data is stored encrypted at rest and in transit.",
                0.89,
            )
        ]
    return []


class DifyMockHandler(BaseHTTPRequestHandler):

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
        path = urlparse(self.path).path
        segments = re.match(r"^/datasets/[^/]+/documents/([^/]+)/segments$",
                            path)
        if segments is not None:
            API_CALLS["segments"] += 1
            doc = DOC_BY_ID[segments.group(1)]
            self._send_json({
                "data": [{
                    "content": content
                } for content in doc[4]],
                "has_more":
                False,
            })
            return
        detail = re.match(r"^/datasets/[^/]+/documents/([^/]+)$", path)
        if detail is not None:
            API_CALLS["detail"] += 1
            self._send_json(_document_detail(DOC_BY_ID[detail.group(1)]))
            return
        if re.match(r"^/datasets/[^/]+/documents$", path) is not None:
            API_CALLS["list"] += 1
            self._send_json({
                "data": [_document_summary(doc) for doc in DOCS],
                "has_more": False,
            })
            return
        self.send_error(404)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if re.match(r"^/datasets/[^/]+/retrieve$", path) is not None:
            API_CALLS["retrieve"] += 1
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            self._send_json(
                {"records": _retrieve_records(body.get("query") or "")})
            return
        self.send_error(404)


# Read-only, deterministic commands exercising path resolution, segment
# reassembly, stat detail, and recursive grep. {root} is the mount root.
PER_MOUNT_CASES: list[tuple[str, str]] = [
    ("ls", "ls {root}"),
    ("ls_guides", "ls {root}guides/"),
    ("tree", "tree {root}"),
    ("find_md", "find {root} -name '*.md'"),
    ("find_type_f", "find {root} -type f | sort"),
    ("find_root_maxdepth0", "find {root} -maxdepth 0"),
    ("find_root_name", "find {root} -name knowledge"),
    ("stat_fmt", "stat -c '%s %n' {root}guides/auth"),
    ("cat_auth", "cat {root}guides/auth"),
    ("head_1", "head -n 1 {root}guides/quickstart"),
    ("tail_1", "tail -n 1 {root}guides/quickstart"),
    ("wc_l", "wc -l {root}guides/auth"),
    ("wc_c", "wc -c {root}policies/refunds"),
    ("grep_429", "grep 429 {root}guides/auth"),
    ("grep_c_rate", "grep -c rate {root}guides/auth"),
    ("grep_e_multi", "grep -e 429 -e rate {root}guides/auth"),
    ("grep_r_refund", "grep -r refund {root}policies/"),
    ("grep_rl_encrypted", "grep -rl encrypted {root}"),
    ("rg_l_token", "rg -l token {root}"),
    ("pipe_sort_uniq_wc", "cat {root}guides/auth | sort | uniq | wc -l"),
    ("pipe_sort_uniq_w0_wc",
     "cat {root}guides/auth | sort | uniq -w 0 | wc -l"),
]

# Dify-native semantic retrieval mirroring examples/python/dify/dify.py. The
# first two run unscoped against the mount root; the third scopes to a folder,
# which the backend turns into a slug metadata filter on the /retrieve call.
SEARCH_CASES: list[tuple[str, str]] = [
    ("search_throttle", 'search "how am I throttled" {root}'),
    ("search_scoped_refund", 'search "money back" {root}policies'),
    ("search_hybrid_encrypted",
     "search --method hybrid --top-k 3 encrypted {root}"),
]

# Index fast-path accounting: run from a fresh workspace and count backend
# calls per route. readdir-driven listing populates the index, so a second
# listing issues zero extra GET /documents calls; cat is the first command to
# hit the segments endpoint.
ACCOUNTING_CASES: list[tuple[str, list[str]]] = [
    ("calls_ls", ["ls {root}"]),
    ("calls_ls_then_guides", ["ls {root}", "ls {root}guides/"]),
    ("calls_cat", ["cat {root}guides/auth"]),
]


def _build_workspace(base_url: str) -> Workspace:
    resource = DifyResource(
        DifyConfig(api_key="testing", base_url=base_url,
                   dataset_id=DATASET_ID))
    return Workspace({MOUNT: resource}, mode=MountMode.READ)


async def _run(ws: Workspace, name: str, cmd: str) -> None:
    result = await ws.execute(cmd)
    out = await result.stdout_str()
    print(f"=== {name} ===")
    print(out, end="" if out.endswith("\n") else "\n")


async def _measure_calls(base_url: str, name: str, cmds: list[str]) -> None:
    ws = _build_workspace(base_url)
    API_CALLS.clear()
    for cmd in cmds:
        await ws.execute(cmd.format(root=MOUNT))
    print(f"=== {name} ===")
    print(f"list={API_CALLS.get('list', 0)} "
          f"detail={API_CALLS.get('detail', 0)} "
          f"segments={API_CALLS.get('segments', 0)} "
          f"retrieve={API_CALLS.get('retrieve', 0)}")


async def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), DifyMockHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    base_url = f"http://{host}:{port}"
    try:
        ws = _build_workspace(base_url)
        for name, tmpl in PER_MOUNT_CASES:
            await _run(ws, name, tmpl.format(root=MOUNT))
        for name, tmpl in SEARCH_CASES:
            await _run(ws, name, tmpl.format(root=MOUNT))
        for name, cmds in ACCOUNTING_CASES:
            await _measure_calls(base_url, name, cmds)
        await run_not_found(ws, MOUNT)
    finally:
        server.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
