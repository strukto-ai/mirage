import copy
import json
import re
import subprocess
from pathlib import Path
from typing import Any

import jsonschema
import yaml
from api_deployments import apply_overrides, deployment_documents
from gen_api_reference import operations, render_overlay, search_terms, slug

ROOT = Path(__file__).resolve().parent.parent


def check_examples(doc: dict[str, Any]) -> int:
    """Validate explicit JSON request and success examples in their own view.

    Args:
        doc (dict[str, Any]): a deployment OpenAPI document.
    """
    count = 0
    for path, method, op in operations(doc):
        media = list(op.get("requestBody", {}).get("content", {}).values())
        for code, response in op["responses"].items():
            if not code.startswith("2"):
                continue
            if "$ref" in response:
                response = doc["components"]["responses"][
                    response["$ref"].rsplit("/", 1)[-1]
                ]
            media.extend(
                [response.get("content", {}).get("application/json", {})]
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
    original = copy.deepcopy(source)
    settings = json.loads((ROOT / "docs/api/deployments.json").read_text())
    views = deployment_documents(source, settings)
    assert source == original
    config = json.loads((ROOT / "docs/docs.json").read_text())
    api = next(
        tab for tab in config["navigation"]["tabs"] if tab["tab"] == "API"
    )
    for dropdown, key in zip(
        api["dropdowns"], ("cloud", "server"), strict=True
    ):
        doc = views[key]
        expected = [m.upper() + " " + p for p, m, _ in operations(doc)]
        linked = operation_links(dropdown)
        assert len(linked) == len(set(linked)) and set(linked) == set(expected)
        paths = [
            slug(op["tags"][0]) + "/" + slug(op["summary"])
            for _, _, op in operations(doc)
        ]
        assert len(paths) == len(set(paths)), "Endpoint page URL collision"
        assert all(
            not op.get("servers") and not op.get("x-codeSamples")
            for _, _, op in operations(doc)
        )
        overlay = json.loads(render_overlay(doc))
        removed = {a["target"] for a in overlay["actions"] if a.get("remove")}
        for path, method, op in operations(doc):
            for code in op["responses"]:
                target = (
                    f"$.paths[{json.dumps(path)}].{method}"
                    f".responses[{json.dumps(code)}]"
                )
                assert (target in removed) == (not code.startswith("2"))
            assert op["tags"][0] not in settings["hidden_tags"]
        prefix = "api" if key == "cloud" else "api/server"
        guide = (ROOT / f"docs/{prefix}/streaming.mdx").read_text()
        assert "{{" not in guide
        assert (
            doc["servers"][0]["url"] + "/v1/workspaces/demo/shell?stream=true"
            in guide
        )
        for snippet in re.findall(r"```bash[^\n]*\n(.*?)```", guide, re.S):
            subprocess.run(
                ["bash", "-n"], input=snippet, text=True, check=True
            )
        print(
            f"{key}: {len(expected)} endpoints, "
            f"{check_examples(doc)} valid JSON examples"
        )
    assert "/v1/daemon/ready" not in views["cloud"]["paths"]
    assert "/v1/me" not in views["server"]["paths"]
    assert "/v1/workspaces/{workspace_id}/shell" in views["cloud"]["paths"]
    for _, _, op in operations(views["cloud"]):
        if op["tags"] == ["VFS"]:
            assert op["x-cloud-implementation-status"] == "planned"
            assert "Cloud implementation is pending" in op["description"]
    terms = search_terms(
        views["server"],
        views["server"]["paths"]["/v1/workspaces/{workspace_id}/logs"]["get"],
        set(),
    )
    assert {"started_at", "exit_code"} <= terms
    http = (ROOT / "docs/home/access/http.mdx").read_text()
    anchors = {slug(title) for title in re.findall(r"^#+ (.+)$", http, re.M)}
    for page in (ROOT / "docs").rglob("*.mdx"):
        for anchor in re.findall(
            r"/home/access/http#([a-z0-9-]+)", page.read_text()
        ):
            assert anchor in anchors, f"{page}: broken HTTP anchor {anchor}"
    # JSON null is data in examples, including when it replaces an existing value.
    assert apply_overrides(
        {"example": {"a": 1}},
        [{"op": "replace", "path": "/example", "value": {"a": None}}],
    ) == {"example": {"a": None}}
    stale = copy.deepcopy(settings)
    stale["operations"]["GET /removed-route"] = {"update": []}
    try:
        deployment_documents(source, stale)
    except ValueError:
        pass
    else:
        raise AssertionError(
            "Removed OSS operations must invalidate their overrides"
        )
    print(
        "Navigation, success-only presentation, deployment availability, "
        "search, and protocol examples passed"
    )


if __name__ == "__main__":
    main()
