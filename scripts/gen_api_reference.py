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
import re
import sys
from html import unescape
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "docs" / "openapi.yaml"
PAGE = ROOT / "docs" / "api" / "reference.mdx"
TAG_ORDER = (
    "Workspaces",
    "Sessions",
    "Shell",
    "VFS",
    "Tools",
    "Documents",
    "Snapshots",
    "Templates",
    "Saved VFS",
    "Saved CLIs",
    "Saved runtimes",
    "Policies",
    "Asks",
    "Server",
    "Auth",
)
METHOD_ORDER = ("get", "post", "put", "patch", "delete")
HEADER = """---
title: API reference
description: "Find an endpoint by resource, path, parameter or response field."
icon: list
---

import { ApiExplorer, Operation } from "/snippets/api-explorer.jsx"

{/* Regenerate with scripts/gen_api_reference.py. */}

Browse the resource groups in the sidebar, or search the operations below.
Each endpoint page includes authentication, request fields, examples and responses.

Use the [quickstart](/api/quickstart) for your first request. Both the local daemon
and hosted API serve the routes labeled **Daemon and hosted**. Routes labeled
**Daemon only** require a local server.

Readiness and shutdown control a server you run yourself, so they are
documented with [launching a server](/home/access/http#server).
"""


def attr(text: str) -> str:
    """Quote a value for a JSX string attribute.

    Args:
        text (str): the raw value.
    """
    return (
        text.replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace("{", "&#123;")
        .replace("}", "&#125;")
    )


def search_terms(doc: dict[str, Any], node: Any, seen: set[str]) -> set[str]:
    """Descriptions, parameter names and nested schema fields for search.

    Args:
        doc (dict[str, Any]): the OpenAPI document.
        node (Any): an operation or one of its schema nodes.
        seen (set[str]): references already visited in this operation.
    """
    if isinstance(node, list):
        return set().union(*(search_terms(doc, item, seen) for item in node))
    if not isinstance(node, dict):
        return set()
    terms: set[str] = set()
    ref = node.get("$ref")
    if ref and ref not in seen:
        seen.add(ref)
        target = doc
        for key in ref.removeprefix("#/").split("/"):
            target = target[key]
        terms.update(search_terms(doc, target, seen))
    for key, value in node.items():
        if key in ("description", "summary", "title", "name"):
            terms.update(str(value).lower().split())
        elif key == "properties":
            terms.update(value)
            terms.update(search_terms(doc, list(value.values()), seen))
        elif key not in ("example", "examples", "x-mint"):
            terms.update(search_terms(doc, value, seen))
    return terms


def slug(text: str) -> str:
    """The URL segment Mintlify derives from a title.

    Args:
        text (str): a tag or summary.
    """
    kept = re.sub(r"[^a-z0-9 _-]", "", text.lower())
    return re.sub(r"\s+", "-", kept.strip())


def resource_name(doc: dict[str, Any], tag: str) -> str:
    """The navigation hierarchy used to label an operation in search.

    Args:
        doc (dict[str, Any]): the OpenAPI document.
        tag (str): the operation's resource tag.
    """
    tags = {item["name"]: item for item in doc.get("tags", [])}
    labels = []
    seen: set[str] = set()
    while tag:
        if tag in seen:
            raise ValueError(f"circular navigation tag: {tag}")
        seen.add(tag)
        item = tags.get(tag, {})
        labels.append(item.get("x-group", item.get("summary", tag)))
        tag = item.get("parent", "")
    return " / ".join(reversed(labels))


def operation(
    doc: dict[str, Any], path: str, method: str, op: dict[str, Any]
) -> list[str]:
    """The searchable link to one complete endpoint page.

    Args:
        doc (dict[str, Any]): the OpenAPI document.
        path (str): the route's path.
        method (str): its lower-case method.
        op (dict[str, Any]): the operation object.
    """
    hosts = ", ".join(op.get("x-hosts", ["daemon"]))
    page = f"/api/operations/{slug(op['tags'][0])}/{slug(op['summary'])}"
    anchor = re.sub(r"[^a-z0-9]+", "-", f"{method} {path}".lower()).strip("-")
    search = " ".join(sorted(search_terms(doc, op, set())))
    return [
        f'<Operation resource="{attr(resource_name(doc, op["tags"][0]))}" '
        f'method="{method.upper()}" path="{attr(path)}" '
        f'summary="{attr(op["summary"])}" hosts="{attr(hosts)}" '
        f'href="{page}" anchor="{anchor}" search="{attr(search)}" />',
        "",
    ]


def order(item: tuple[str, str, dict[str, Any]]) -> tuple[int, str, int]:
    """Where an operation sits on the page: by resource, then path, then
    method.

    Args:
        item (tuple[str, str, dict[str, Any]]): ``(path, method, op)``.
    """
    path, method, op = item
    tag = op["tags"][0]
    rank = TAG_ORDER.index(tag) if tag in TAG_ORDER else len(TAG_ORDER)
    return rank, path, METHOD_ORDER.index(method)


def render(doc: dict[str, Any]) -> str:
    """The whole reference page.

    Args:
        doc (dict[str, Any]): the OpenAPI document.
    """
    ops = [
        (path, method, op)
        for path, methods in doc["paths"].items()
        for method, op in methods.items()
        if method in METHOD_ORDER
        and not op.get("x-excluded")
        and not op.get("x-hidden")
    ]
    lines = [HEADER, "<ApiExplorer>", ""]
    for path, method, op in sorted(ops, key=order):
        lines += operation(doc, path, method, op)
    lines.append("</ApiExplorer>")
    return "\n".join(lines) + "\n"


def selftest() -> None:
    """Check search coverage and valid attribute text on a recursive schema."""
    shared = {"$ref": "#/components/schemas/Shared"}
    node = {"$ref": "#/components/schemas/Node"}
    doc = {
        "tags": [
            {"name": "Workspace operations", "x-group": "Workspaces"},
            {"name": "VFS", "parent": "Workspace operations"},
        ],
        "components": {
            "schemas": {
                "Shared": {"properties": {"filename": {"type": "string"}}},
                "Node": {
                    "allOf": [
                        shared,
                        {"properties": {"child": node}},
                    ]
                },
            }
        },
    }
    op = {
        "summary": "Read files",
        "description": 'Read a "file" at {path} & return <bytes>.',
        "tags": ["VFS"],
        "parameters": [
            {"name": "stream", "description": "Stream the response."}
        ],
        "requestBody": {
            "content": {
                "application/json": {
                    "schema": {"allOf": [node, shared]},
                    "example": {"not_searchable": "unused"},
                }
            }
        },
        "responses": {
            "200": {
                "content": {
                    "application/json": {
                        "schema": {"properties": {"data": shared}}
                    }
                }
            }
        },
    }
    terms = search_terms(doc, op, set())
    assert {"filename", "child", "stream", "data", "response."} <= terms
    assert "not_searchable" not in terms

    text = '"{path}" & <bytes> \\ &quot;'
    escaped = attr(text)
    assert unescape(escaped) == text
    assert not any(char in escaped for char in ('"', "{", "}", "<"))

    output = "\n".join(operation(doc, "/v1/files/{path}", "post", op))
    assert 'href="/api/operations/vfs/read-files"' in output
    assert 'resource="Workspaces / VFS"' in output
    assert 'anchor="post-v1-files-path"' in output
    assert "filename" in output and "stream" in output
    assert "&quot;file&quot;" in output and "&#123;path&#125;" in output

    doc["paths"] = {
        "/visible": {"get": op},
        "/hidden": {"post": {**op, "x-hidden": True}},
    }
    page = render(doc)
    assert 'path="/visible"' in page
    assert 'path="/hidden"' not in page
    print("API reference self-test passed")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="check recursive search and attribute escaping",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail when the committed page differs from the generated one",
    )
    args = parser.parse_args()
    if args.selftest:
        selftest()
        if not args.check:
            return 0
    page = render(yaml.safe_load(SPEC.read_text()))
    if args.check:
        if not PAGE.exists() or PAGE.read_text() != page:
            print(
                f"{PAGE.relative_to(ROOT)} is stale; run "
                "python scripts/gen_api_reference.py"
            )
            return 1
        print(f"{PAGE.relative_to(ROOT)} is up to date")
        return 0
    PAGE.parent.mkdir(parents=True, exist_ok=True)
    PAGE.write_text(page)
    print(f"wrote {PAGE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
