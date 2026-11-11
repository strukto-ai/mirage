import json
import re
import subprocess
from pathlib import Path
from typing import Any

import jsonschema
import yaml
from gen_api_reference import (
    METHOD_ORDER,
    operations,
    render_overlay,
    search_terms,
    slug,
)

ROOT = Path(__file__).resolve().parent.parent
TIME_FIELD = re.compile(r"_at$|^timestamp$")


def resolve(doc: dict[str, Any], node: dict[str, Any]) -> dict[str, Any]:
    """Follow a local ``$ref`` to the component it names.

    Args:
        doc (dict[str, Any]): the OpenAPI contract.
        node (dict[str, Any]): a schema or response, maybe a ``$ref``.
    """
    while "$ref" in node:
        _, _, section, name = node["$ref"].split("/")
        node = doc["components"][section][name]
    return node


def is_date_time(schema: dict[str, Any]) -> bool:
    """Whether a schema is an RFC 3339 string, or that or null.

    Args:
        schema (dict[str, Any]): a property's schema.
    """
    branches = schema.get("anyOf") or schema.get("oneOf")
    if branches:
        kept = [b for b in branches if b.get("type") != "null"]
        return bool(kept) and all(is_date_time(b) for b in kept)
    kind = schema.get("type")
    kinds = set(kind) if isinstance(kind, list) else {kind}
    return (
        "string" in kinds
        and kinds <= {"string", "null"}
        and schema.get("format") == "date-time"
    )


def time_fields(node: Any) -> list[tuple[str, dict[str, Any]]]:
    """Every property named as a time, anywhere under ``node``.

    Args:
        node (Any): a part of the OpenAPI contract.
    """
    if isinstance(node, list):
        return [found for item in node for found in time_fields(item)]
    if not isinstance(node, dict):
        return []
    found = [
        (name, schema)
        for name, schema in (node.get("properties") or {}).items()
        if TIME_FIELD.search(name) and isinstance(schema, dict)
    ]
    return found + [
        hit
        for key, value in node.items()
        if key not in ("example", "examples")
        for hit in time_fields(value)
    ]


def check_conventions(doc: dict[str, Any]) -> tuple[int, int]:
    """Hold the contract to the API's shapes: a list answers
    ``{"items": [...]}``, never a bare array, and a time is an RFC 3339
    string (``format: date-time``).

    Args:
        doc (dict[str, Any]): the OpenAPI contract.
    """
    answers = 0
    for path, methods in doc["paths"].items():
        for method, op in methods.items():
            if method not in METHOD_ORDER:
                continue
            for code, response in op["responses"].items():
                if not code.startswith("2"):
                    continue
                schema = (
                    resolve(doc, response)
                    .get("content", {})
                    .get("application/json", {})
                    .get("schema")
                )
                if schema is None:
                    continue
                assert resolve(doc, schema).get("type") != "array", (
                    f"{method.upper()} {path}: answer a list as "
                    '{"items": [...]}, not a bare array'
                )
                answers += 1
    times = time_fields(doc)
    for name, schema in times:
        assert is_date_time(schema), (
            f"{name}: a time is a string with format: date-time"
        )
    return answers, len(times)


def check_examples(doc: dict[str, Any]) -> int:
    """Validate JSON examples against their schemas in the source contract.

    Args:
        doc (dict[str, Any]): the OpenAPI contract.
    """
    count = 0
    for path, method, op in operations(doc):
        media = [
            op.get("requestBody", {})
            .get("content", {})
            .get("application/json", {})
        ]
        for response in op["responses"].values():
            if "$ref" in response:
                response = doc["components"]["responses"][
                    response["$ref"].rsplit("/", 1)[-1]
                ]
            media.append(
                response.get("content", {}).get("application/json", {})
            )
        for content in media:
            given = (
                [content["example"]]
                if "example" in content
                else [
                    item["value"]
                    for item in content.get("examples", {}).values()
                ]
            )
            for example in given:
                schema = {
                    **content.get("schema", {}),
                    "components": doc["components"],
                }
                errors = list(
                    jsonschema.Draft202012Validator(schema).iter_errors(
                        example
                    )
                )
                assert not errors, f"{method} {path}: {errors[0].message}"
                count += 1
    return count


def operation_links(node: Any) -> list[str]:
    """Collect endpoint entries in Mintlify navigation.

    Args:
        node (Any): a navigation node.
    """
    if isinstance(node, str):
        return (
            [node] if re.match(r"^(GET|POST|PUT|PATCH|DELETE) ", node) else []
        )
    if isinstance(node, list):
        return [page for item in node for page in operation_links(item)]
    return operation_links(node.get("groups", [])) + operation_links(
        node.get("pages", [])
    )


def main() -> None:
    source = yaml.safe_load((ROOT / "docs/openapi.yaml").read_text())
    original = json.dumps(source)
    visible = operations(source)
    config = json.loads((ROOT / "docs/docs.json").read_text())
    api = next(
        tab
        for tab in config["navigation"]["tabs"]
        if tab["tab"] == "API reference"
    )
    assert "dropdowns" not in api
    expected = [m.upper() + " " + p for p, m, _ in visible]
    linked = operation_links(api)
    assert len(linked) == len(set(linked)) and set(linked) == set(expected)
    targets = {
        f"/api/operations/{slug(op['tags'][0])}/{slug(op['summary'])}"
        for _, _, op in visible
    }
    assert len(targets) == len(visible), "Endpoint page URL collision"
    redirects = {
        item["source"]: item["destination"]
        for item in config.get("redirects", [])
    }
    assert len(redirects) == len(config.get("redirects", [])), (
        "Duplicate redirect source"
    )
    for redirect_source, destination in redirects.items():
        if redirect_source.startswith("/api/operations/"):
            assert redirect_source not in targets, (
                f"Redirect shadows endpoint {redirect_source}"
            )
            assert destination in targets, (
                f"Redirect points to missing endpoint {destination}"
            )
    for group in api["groups"]:
        if "openapi" in group:
            assert group["openapi"] == {
                "source": "openapi.yaml",
                "overlays": ["api-display.overlay.json"],
                "directory": "api/operations",
            }
    overlay = json.loads(render_overlay(source))
    removed = {a["target"] for a in overlay["actions"] if a.get("remove")}
    for action in overlay["actions"]:
        for sample in action.get("update", {}).get("x-codeSamples", []):
            subprocess.run(
                ["bash", "-n"], input=sample["source"], text=True, check=True
            )
    for path, method, op in visible:
        assert not op.get("x-codeSamples")
        for server in op.get("servers", source["servers"]):
            assert server["url"] == "http://127.0.0.1:8765"
        for code in op["responses"]:
            target = (
                f"$.paths[{json.dumps(path)}].{method}"
                f".responses[{json.dumps(code)}]"
            )
            assert (target in removed) == (not code.startswith("2"))
    assert json.dumps(source) == original, (
        "Presentation must leave the contract complete"
    )
    for tag in ["Sessions", "Snapshots", "Tools", "Auth"]:
        assert not any(op["tags"] == [tag] for _, _, op in visible)
    assert "/v1/daemon/ready" in source["paths"]
    assert "/v1/me" not in source["paths"]
    terms = search_terms(
        source,
        source["paths"]["/v1/workspaces/{workspace_id}/logs"]["get"],
        set(),
    )
    assert {"started_at", "exit_code"} <= terms
    http = (ROOT / "docs/home/access/http.mdx").read_text()
    anchors = {slug(title) for title in re.findall(r"^#+ (.+)$", http, re.M)}
    for page in (ROOT / "docs").rglob("*.mdx"):
        body = page.read_text()
        for anchor in re.findall(r"/home/access/http#([a-z0-9-]+)", body):
            assert anchor in anchors, f"{page}: broken HTTP anchor {anchor}"
        for target in re.findall(
            r"(/api/(?:server/)?operations/[a-z0-9_/-]+)", body
        ):
            assert target in targets, f"{page}: broken endpoint link {target}"
    for name in ("overview", "quickstart", "authentication", "streaming"):
        guide = (ROOT / f"docs/api/{name}.mdx").read_text()
        for snippet in re.findall(r"```bash[^\n]*\n(.*?)```", guide, re.S):
            subprocess.run(
                ["bash", "-n"], input=snippet, text=True, check=True
            )
    answers, times = check_conventions(source)
    print(
        f"{len(visible)} endpoints navigable; "
        f"{check_examples(source)} JSON examples valid; "
        f"{answers} JSON answers are objects; {times} times are date-time"
    )
    print(
        "Single OpenAPI source, success-only display, search, and guide links passed"
    )


if __name__ == "__main__":
    main()
