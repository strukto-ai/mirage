import json
import re
import subprocess
from pathlib import Path
from typing import Any

import jsonschema
import yaml
from gen_api_reference import operations, render_overlay, search_terms, slug

ROOT = Path(__file__).resolve().parent.parent


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
        tab for tab in config["navigation"]["tabs"] if tab["tab"] == "API"
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
    for group in api["groups"]:
        if "openapi" in group:
            assert group["openapi"] == {
                "source": "openapi.yaml",
                "overlays": ["api-display.overlay.json"],
                "directory": "api/operations",
            }
    overlay = json.loads(render_overlay(source))
    removed = {a["target"] for a in overlay["actions"] if a.get("remove")}
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
    print(
        f"{len(visible)} endpoints navigable; "
        f"{check_examples(source)} JSON examples valid"
    )
    print(
        "Single OpenAPI source, success-only display, search, and guide links passed"
    )


if __name__ == "__main__":
    main()
