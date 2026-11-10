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
import json
import re
import sys
from html import unescape
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "docs" / "openapi.yaml"
PAGE = ROOT / "docs" / "api" / "reference.mdx"
OVERLAY = ROOT / "docs" / "api-display.overlay.json"
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
    "Saved machines",
    "Policies",
    "Asks",
    "Lines",
    "Jobs",
    "Processes",
    "Machines",
    "Service",
    "Daemon",
    "Auth",
)
METHOD_ORDER = ("get", "post", "put", "patch", "delete")
SAMPLES = {
    ("/v1/workspaces/{workspace_id}/shell", "post"): [
        {
            "lang": "bash",
            "label": "Run a command",
            "source": (
                "curl --request POST \\\n"
                "  --url 'http://127.0.0.1:8765/v1/workspaces/"
                "{workspace_id}/shell' \\\n"
                "  --header 'Authorization: Bearer <token>' \\\n"
                "  --header 'Content-Type: application/json' \\\n"
                '  --data \'{"command":"echo hello"}\'\n'
            ),
        }
    ]
}


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
    doc: dict[str, Any],
    path: str,
    method: str,
    op: dict[str, Any],
) -> list[str]:
    """The searchable link to one complete endpoint page.

    Args:
        doc (dict[str, Any]): the OpenAPI document.
        path (str): the route's path.
        method (str): its lower-case method.
        op (dict[str, Any]): the operation object.
    """
    page = f"/api/operations/{slug(op['tags'][0])}/{slug(op['summary'])}"
    anchor = re.sub(r"[^a-z0-9]+", "-", f"{method} {path}".lower()).strip("-")
    search = " ".join(sorted(search_terms(doc, op, set())))
    return [
        f'<Operation resource="{attr(resource_name(doc, op["tags"][0]))}" '
        f'method="{method.upper()}" path="{attr(path)}" '
        f'summary="{attr(op["summary"])}" '
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


def operations(doc: dict[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
    """Visible operations in resource order.

    Args:
        doc (dict[str, Any]): the OpenAPI document.
    """
    return sorted(
        [
            (path, method, op)
            for path, methods in doc["paths"].items()
            for method, op in methods.items()
            if method in METHOD_ORDER
            and not op.get("x-hidden")
            and not op.get("x-excluded")
        ],
        key=order,
    )


def render(doc: dict[str, Any]) -> str:
    """The whole reference page.

    Args:
        doc (dict[str, Any]): the OpenAPI document.
    """
    header = """---
title: API reference
description: Find endpoints by resource, path, parameter, or response field.
icon: list
---

import { ApiExplorer, Operation } from "/snippets/api-explorer.jsx"

{/* Regenerate with scripts/gen_api_reference.py. */}

Browse the resource groups in the sidebar, or search the operations below.
Each endpoint includes request fields, response schemas, and examples from the
[OpenAPI contract](https://github.com/strukto-ai/mirage/blob/main/docs/openapi.yaml).
"""
    lines = [header, "<ApiExplorer>", ""]
    for path, method, op in operations(doc):
        lines += operation(doc, path, method, op)
    lines.append("</ApiExplorer>")
    return "\n".join(lines) + "\n"


def response_content(doc: dict[str, Any], op: dict[str, Any]) -> str:
    """Success example overrides and a secondary list of endpoint errors.

    Args:
        doc (dict[str, Any]): the OpenAPI document.
        op (dict[str, Any]): the operation object.
    """
    responses = {}
    for code, response in op.get("responses", {}).items():
        if "$ref" in response:
            response = {
                **doc["components"]["responses"][
                    response["$ref"].split("/")[-1]
                ],
                **response,
            }
        responses[code] = response
    lines = []
    created = (
        responses.get("201", {}).get("content", {}).get("application/json", {})
    )
    markdown = (
        responses.get("200", {}).get("content", {}).get("text/markdown", {})
    )
    generic = (
        responses.get("200", {}).get("content", {}).get("application/json", {})
    )
    streamed = (
        responses.get("200", {}).get("content", {}).get("application/x-ndjson")
    )
    example = []
    if "200" in responses and "example" in created:
        example = [
            "```json 201 Created",
            json.dumps(created["example"], indent=2),
            "```",
        ]
    elif {code for code in responses if code.startswith("2")} == {"204"}:
        example = ["```http 204 No Content", "HTTP/1.1 204 No Content", "```"]
    elif "example" in markdown:
        text = markdown["example"]
        longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
        fence = "`" * max(3, longest + 1)
        example = [f"{fence}markdown 200", text, fence]
    elif generic.get("schema") == {} and "example" not in generic:
        example = [
            "```http 200 Headers only",
            "HTTP/1.1 200 OK\nContent-Type: application/json",
            "```",
        ]
    elif streamed is not None and "example" not in streamed:
        example = [
            "```json 200",
            json.dumps(generic["example"], indent=2),
            "```",
        ]
    if example:
        lines += [
            '<div className="hidden">',
            "<ResponseExample>",
            "",
            *example,
            "",
            "</ResponseExample>",
            "</div>",
            "",
        ]
    errors = [
        (code, value)
        for code, value in responses.items()
        if not code.startswith("2")
    ]
    if errors:
        lines += [
            '<Accordion title="Errors">',
            "",
            "| Status | Meaning |",
            "| --- | --- |",
        ]
        for code, response in errors:
            description = (
                attr(response["description"])
                .replace("\n", " ")
                .replace("|", "\\|")
            )
            lines.append(f"| `{code}` | {description} |")
        lines += [
            "",
            "See [error examples and recovery steps](/api/errors). "
            "The [complete OpenAPI contract]("
            "https://github.com/strukto-ai/mirage/blob/main/docs/openapi.yaml) "
            "includes every response schema.",
            "",
            "</Accordion>",
        ]
    return "\n".join(lines)


def render_overlay(doc: dict[str, Any]) -> str:
    """Presentation changes that leave the source API contract complete.

    A request sample that must differ from the generated one comes from
    `SAMPLES`. An operation that also streams NDJSON documents the stream
    in its description, so its response pane shows the JSON example only.
    A description moves below the method and path: it leads the page
    content, and the description field itself is removed.

    Args:
        doc (dict[str, Any]): the OpenAPI document.
    """
    actions: list[dict[str, Any]] = []
    for path, method, op in operations(doc):
        update: dict[str, Any] = {}
        description = op.get("description", "").strip()
        content = "\n\n".join(
            part for part in (description, response_content(doc, op)) if part
        )
        if content:
            update["x-mint"] = {"content": content}
        if (path, method) in SAMPLES:
            update["x-codeSamples"] = SAMPLES[(path, method)]
        if update:
            actions.append(
                {
                    "target": f"$.paths[{json.dumps(path)}].{method}",
                    "update": update,
                }
            )
        if description:
            actions.append(
                {
                    "target": f"$.paths[{json.dumps(path)}].{method}"
                    ".description",
                    "remove": True,
                }
            )
        for code in op.get("responses", {}):
            if not code.startswith("2"):
                actions.append(
                    {
                        "target": f"$.paths[{json.dumps(path)}].{method}"
                        f".responses[{json.dumps(code)}]",
                        "remove": True,
                    }
                )
    return (
        json.dumps(
            {
                "overlay": "1.0.0",
                "info": {
                    "title": "API documentation presentation",
                    "version": "1.0.0",
                },
                "actions": actions,
            },
            indent=2,
        )
        + "\n"
    )


def selftest() -> None:
    """Check search coverage and valid attribute text on a recursive schema."""
    shared = {"$ref": "#/components/schemas/Shared"}
    node = {"$ref": "#/components/schemas/Node"}
    doc: dict[str, Any] = {
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
    op: dict[str, Any] = {
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
        "/excluded": {"get": {**op, "x-excluded": True}},
    }
    page = render(doc)
    assert 'path="/visible"' in page
    assert 'path="/hidden"' not in page
    assert 'path="/excluded"' not in page

    doc["components"]["responses"] = {
        "409": {"description": "Conflicting configuration"}
    }
    op["responses"]["201"] = {
        "content": {"application/json": {"example": {"id": "demo"}}}
    }
    op["responses"]["409"] = {"$ref": "#/components/responses/409"}
    original = json.dumps(doc)
    overlay = json.loads(render_overlay(doc))
    assert json.dumps(doc) == original
    assert len(overlay["actions"]) == 3
    content = overlay["actions"][0]["update"]["x-mint"]["content"]
    assert content.startswith(op["description"] + "\n\n")
    assert "201 Created" in content and "Conflicting configuration" in content
    assert '<Accordion title="Errors">' in content
    assert overlay["actions"][1] == {
        "target": '$.paths["/visible"].get.description',
        "remove": True,
    }
    assert overlay["actions"][-1] == {
        "target": '$.paths["/visible"].get.responses["409"]',
        "remove": True,
    }
    assert "description" not in overlay["actions"][0]["update"]

    op["description"] = (
        "Run a line.\n\n| Mode | Use |\n| --- | --- |\n\n## Examples\n"
    )
    assert "examples" in render(doc)
    overlay = json.loads(render_overlay(doc))
    update = overlay["actions"][0]["update"]
    assert "description" not in update
    content = update["x-mint"]["content"]
    assert content.startswith(
        "Run a line.\n\n| Mode | Use |\n| --- | --- |\n\n## Examples\n\n"
    )
    assert content.index("## Examples") < content.index("201 Created")
    bare = json.loads(
        render_overlay(
            {
                "paths": {
                    "/bare": {
                        "get": {
                            "tags": ["VFS"],
                            "description": " \n",
                            "responses": {"404": {"description": "Gone"}},
                        }
                    }
                }
            }
        )
    )
    assert [action["target"] for action in bare["actions"]] == [
        '$.paths["/bare"].get',
        '$.paths["/bare"].get.responses["404"]',
    ]
    assert bare["actions"][0]["update"]["x-mint"]["content"].startswith(
        '<Accordion title="Errors">'
    )
    lone = json.loads(
        render_overlay(
            {
                "paths": {
                    "/lone": {
                        "get": {
                            "tags": ["VFS"],
                            "description": "Lead.\n\nMore.",
                            "responses": {"200": {"description": "OK"}},
                        }
                    }
                }
            }
        )
    )
    assert lone["actions"] == [
        {
            "target": '$.paths["/lone"].get',
            "update": {"x-mint": {"content": "Lead.\n\nMore."}},
        },
        {"target": '$.paths["/lone"].get.description', "remove": True},
    ]
    empty_response = response_content(
        doc, {"responses": {"204": {"description": "No content"}}}
    )
    assert "204 No Content" in empty_response
    assert "```http" in empty_response and "```json" not in empty_response
    markdown_text = "# Commands\n\n```sh\necho hello\n```\n"
    doc["components"]["responses"]["Document"] = {
        "description": "Generated document",
        "content": {"text/markdown": {"example": markdown_text}},
    }
    markdown_response = response_content(
        doc,
        {"responses": {"200": {"$ref": "#/components/responses/Document"}}},
    )
    assert (
        "````markdown 200" in markdown_response
        and markdown_text in markdown_response
    )
    generic_response = response_content(
        doc,
        {
            "responses": {
                "200": {"content": {"application/json": {"schema": {}}}}
            }
        },
    )
    assert (
        "200 Headers only" in generic_response
        and "Content-Type: application/json" in generic_response
    )
    streamed_response = response_content(
        doc,
        {
            "responses": {
                "200": {
                    "content": {
                        "application/json": {"example": {"id": "demo"}},
                        "application/x-ndjson": {"schema": {"type": "string"}},
                    }
                }
            }
        },
    )
    assert streamed_response.count("```json 200") == 1
    assert '```json 200\n{\n  "id": "demo"\n}\n```' in streamed_response
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
    doc = yaml.safe_load(SPEC.read_text())
    outputs = {PAGE: render(doc), OVERLAY: render_overlay(doc)}
    if args.check:
        stale = [
            path
            for path, content in outputs.items()
            if not path.exists() or path.read_text() != content
        ]
        for path in stale:
            print(
                f"{path.relative_to(ROOT)} is stale; run "
                "python scripts/gen_api_reference.py"
            )
        if stale:
            return 1
        print("API reference and presentation overlay are up to date")
        return 0
    for path, content in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        print(f"wrote {path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
