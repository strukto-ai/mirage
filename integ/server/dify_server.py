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

import argparse
import asyncio
from typing import Any

from aiohttp import web

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


def _document_summary(doc: tuple) -> dict:
    doc_id, name, slug, size, _segments = doc
    metadata = [{"name": "slug", "value": slug}] if slug is not None else []
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
    if "refund" in lowered or "money" in lowered:
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
    if "encrypt" in lowered or "privacy" in lowered:
        return [
            _build_record(
                "doc-privacy",
                "Customer data is stored encrypted at rest and in transit.",
                0.89,
            )
        ]
    return []


class FakeDify:

    def __init__(self) -> None:
        self.base = ""


class DifyServer:

    def __init__(self, state: FakeDify) -> None:
        self.state = state

    async def reset(self, request: web.Request) -> web.Response:
        return web.json_response({"ok": True})

    async def documents(self, request: web.Request) -> web.Response:
        return web.json_response({
            "data": [_document_summary(doc) for doc in DOCS],
            "has_more":
            False,
        })

    async def document(self, request: web.Request) -> web.Response:
        doc = DOC_BY_ID.get(request.match_info["doc_id"])
        if doc is None:
            return web.json_response({"message": "document not found"},
                                     status=404)
        return web.json_response(_document_detail(doc))

    async def segments(self, request: web.Request) -> web.Response:
        doc = DOC_BY_ID.get(request.match_info["doc_id"])
        if doc is None:
            return web.json_response({"message": "document not found"},
                                     status=404)
        return web.json_response({
            "data": [{
                "content": content
            } for content in doc[4]],
            "has_more":
            False,
        })

    async def retrieve(self, request: web.Request) -> web.Response:
        body: dict[str, Any] = await request.json()
        records = _retrieve_records(body.get("query") or "")
        return web.json_response({"records": records})


def build_app(server: DifyServer) -> web.Application:
    app = web.Application()
    app.router.add_post("/reset", server.reset)
    app.router.add_get("/datasets/{dataset_id}/documents", server.documents)
    app.router.add_get("/datasets/{dataset_id}/documents/{doc_id}/segments",
                       server.segments)
    app.router.add_get("/datasets/{dataset_id}/documents/{doc_id}",
                       server.document)
    app.router.add_post("/datasets/{dataset_id}/retrieve", server.retrieve)
    return app


async def start_fake_dify() -> tuple[FakeDify, DifyServer, web.AppRunner]:
    state = FakeDify()
    server = DifyServer(state)
    runner = web.AppRunner(build_app(server))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    state.base = f"http://127.0.0.1:{port}"
    return state, server, runner


async def _serve(port: int) -> None:
    state = FakeDify()
    server = DifyServer(state)
    runner = web.AppRunner(build_app(server))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    state.base = f"http://127.0.0.1:{port}"
    print(f"DIFY_ENDPOINT={state.base}", flush=True)
    await asyncio.Event().wait()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    asyncio.run(_serve(args.port))


if __name__ == "__main__":
    main()
