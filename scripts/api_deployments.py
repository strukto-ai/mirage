import copy
import json
from pathlib import Path
from typing import Any

METHODS = ("get", "post", "put", "patch", "delete")
DEPLOYMENTS = (
    ("cloud", "Cloud", "cloud", "api", "https://api.strukto.ai"),
    ("server", "OSS Server", "server", "api/server", "http://127.0.0.1:8765"),
)


def apply_overrides(
    target: dict[str, Any], patches: list[dict[str, Any]]
) -> dict[str, Any]:
    """Apply JSON Patch operations on object members without mutating inputs.

    Args:
        target (dict[str, Any]): the original JSON object.
        patches (list[dict[str, Any]]): object-member JSON Patch operations.
    """
    result = copy.deepcopy(target)
    for patch in patches:
        keys = [
            key.replace("~1", "/").replace("~0", "~")
            for key in patch["path"].removeprefix("/").split("/")
        ]
        parent = result
        for key in keys[:-1]:
            parent = parent[key]
        key = keys[-1]
        if patch["op"] == "remove":
            del parent[key]
        elif patch["op"] in ("add", "replace"):
            if patch["op"] == "replace" and key not in parent:
                raise ValueError(
                    f"Stale documentation override: {patch['path']}"
                )
            parent[key] = copy.deepcopy(patch["value"])
        else:
            raise ValueError(f"Unsupported documentation patch: {patch['op']}")
    return result


def prune_components(doc: dict[str, Any]) -> None:
    """Keep only components reachable from the deployment's operations.

    Args:
        doc (dict[str, Any]): a generated deployment document.
    """
    pending = [doc["paths"], doc.get("security", [])]
    kept: dict[str, dict[str, Any]] = {}
    while pending:
        node = pending.pop()
        if isinstance(node, list):
            pending.extend(node)
        elif isinstance(node, dict):
            pending.extend(node.values())
            ref = node.get("$ref", "")
            if ref.startswith("#/components/"):
                _, _, kind, name = ref.split("/")
                if name not in kept.get(kind, {}):
                    target = doc["components"][kind][name]
                    kept.setdefault(kind, {})[name] = target
                    pending.append(target)
    # Security requirements name schemes rather than referencing them.
    schemes = doc["components"].get("securitySchemes", {})
    kept["securitySchemes"] = schemes
    doc["components"] = kept


def deployment_documents(
    source: dict[str, Any], settings: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    """Build deployment views from the OSS contract and explicit differences.

    Args:
        source (dict[str, Any]): the maintained OSS OpenAPI contract.
        settings (dict[str, Any]): common documentation and Cloud JSON patches.
    """
    common = copy.deepcopy(source)
    common["components"] = apply_overrides(
        source["components"], settings["components"]
    )
    common["paths"] = {}
    updates = settings["operations"]
    for path, methods in source["paths"].items():
        for method, original in methods.items():
            if method not in METHODS:
                continue
            hidden = (
                original["tags"][0] in settings["hidden_tags"]
                or "/sessions/" in path
                or (
                    original.get("x-excluded", False)
                    and not path.startswith("/v1/daemon/")
                )
            )
            op = copy.deepcopy(original)
            for field in (
                "servers",
                "x-excluded",
                "x-hosts",
                "x-mint",
                "x-codeSamples",
            ):
                op.pop(field, None)
            if hidden:
                op["x-excluded"] = True
            if path.startswith("/v1/daemon/"):
                op["tags"] = ["Daemon"]
            elif op["tags"] == ["Server"]:
                op["tags"] = ["Service"]
            key = method.upper() + " " + path
            update = updates.get(key, {})
            op = apply_overrides(op, update.get("update", []))
            if update.get("note"):
                op["description"] = (
                    "<Note>\n"
                    + update["note"]
                    + "\n</Note>\n\n"
                    + op.get("description", "")
                )
            common["paths"].setdefault(path, {})[method] = op
    available = {
        m.upper() + " " + p for p, ms in common["paths"].items() for m in ms
    }
    stale = updates.keys() - available
    if stale:
        raise ValueError(
            "Documentation overrides no longer match OSS operations: "
            f"{sorted(stale)}"
        )
    stale_cloud = (
        settings["cloud_operations"].keys()
        - available
        - set(settings["cloud_only_operations"])
    )
    if stale_cloud:
        raise ValueError(
            f"Cloud overrides no longer match: {sorted(stale_cloud)}"
        )
    common["tags"] = [
        t
        for t in source["tags"]
        if t["name"] not in set(settings["hidden_tags"]) | {"Server"}
    ]
    common["tags"] += [
        {"name": tag} for tag in ("Daemon", "Service", "Account")
    ]
    views = {}
    for key, label, _, _, url in DEPLOYMENTS:
        doc = copy.deepcopy(common)
        doc["info"]["title"] = "Mirage " + label + " API"
        doc["servers"] = [{"url": url, "description": label}]
        doc["x-deployment"] = key
        if key == "cloud":
            doc["paths"] = {}
            for operation, patch in settings["cloud_operations"].items():
                method, path = operation.split(" ", 1)
                method = method.lower()
                base = common["paths"].get(path, {}).get(method, {})
                op = apply_overrides(base, patch)
                if op["tags"][0] in settings["planned_cloud_tags"]:
                    op["x-cloud-implementation-status"] = "planned"
                    op["description"] = (
                        "<Note>\nThis endpoint describes the planned Cloud "
                        "contract. The Cloud implementation is pending. "
                        "It is available in OSS Server.\n</Note>\n\n"
                        + op.get("description", "")
                    )
                for code, response in list(op["responses"].items()):
                    if not code.startswith("2"):
                        if "$ref" in response:
                            response = copy.deepcopy(
                                doc["components"]["responses"][
                                    response["$ref"].rsplit("/", 1)[-1]
                                ]
                            )
                        response["content"] = {
                            "application/json": {
                                "schema": {
                                    "$ref": "#/components/schemas/CloudError"
                                }
                            }
                        }
                        op["responses"][code] = response
                doc["paths"].setdefault(path, {})[method] = op
        else:
            for methods in doc["paths"].values():
                for op in methods.values():
                    op["description"] = op.get("description", "").replace(
                        "](/api/streaming", "](/api/server/streaming"
                    )
        prune_components(doc)
        views[key] = doc
    return views


def navigation(
    doc: dict[str, Any], key: str, prefix: str
) -> list[dict[str, Any]]:
    """Group workspace operations beneath their owning resource.

    Args:
        doc (dict[str, Any]): the deployment document.
        key (str): the deployment key.
        prefix (str): its documentation directory.
    """
    spec = {
        "source": f"api/deployments/{key}.json",
        "overlays": [f"api/deployments/{key}.overlay.json"],
        "directory": f"{prefix}/operations",
    }
    tags: dict[str, list[str]] = {}
    for path, methods in doc["paths"].items():
        for method, op in methods.items():
            if op.get("x-excluded"):
                continue
            tags.setdefault(op["tags"][0], []).append(
                method.upper() + " " + path
            )
    groups: list[dict[str, Any]] = [
        {
            "group": "HTTP API",
            "pages": [
                f"{prefix}/{page}"
                for page in (
                    "overview",
                    "quickstart",
                    "authentication",
                    "streaming",
                    "errors",
                    "reference",
                )
            ],
        }
    ]
    for label, entries in [
        (
            "Workspaces",
            [
                ("Lifecycle", "Workspaces"),
                ("Shell", "Shell"),
                ("VFS", "VFS"),
                ("Documents", "Documents"),
                ("Asks", "Asks"),
                ("Lines", "Lines"),
                ("Jobs", "Jobs"),
                ("Processes", "Processes"),
            ],
        ),
        ("Templates", [("Templates", "Templates")]),
        ("Policies", [("Policies", "Policies")]),
        (
            "Saved configurations",
            [
                ("VFS", "Saved VFS"),
                ("CLIs", "Saved CLIs"),
                ("Runtimes", "Saved runtimes"),
            ],
        ),
        ("Account", [("Account", "Account")]),
        ("Service", [("Service", "Service")]),
        ("Daemon", [("Daemon", "Daemon")]),
    ]:
        pages = [
            {"group": name, "pages": tags[tag]}
            for name, tag in entries
            if tag in tags
        ]
        if pages:
            if len(entries) == 1:
                groups.append({**pages[0], "openapi": spec})
            else:
                groups.append(
                    {"group": label, "openapi": spec, "pages": pages}
                )
    return groups


def deployment_outputs(root: Path, source: dict[str, Any]) -> dict[Path, str]:
    """Generate specs, navigation, and shared protocol guides.

    Args:
        root (Path): the repository root.
        source (dict[str, Any]): the OSS OpenAPI contract.
    """
    settings = json.loads((root / "docs/api/deployments.json").read_text())
    views = deployment_documents(source, settings)
    config = json.loads((root / "docs/docs.json").read_text())
    api = next(
        tab for tab in config["navigation"]["tabs"] if tab["tab"] == "API"
    )
    api.pop("groups", None)
    api["dropdowns"] = []
    outputs = {}
    template = (root / "docs/snippets/api/streaming.mdx").read_text()
    for key, label, icon, prefix, url in DEPLOYMENTS:
        doc = views[key]
        outputs[root / f"docs/api/deployments/{key}.json"] = (
            json.dumps(doc, indent=2) + "\n"
        )
        api["dropdowns"].append(
            {
                "dropdown": label,
                "icon": icon,
                "groups": navigation(doc, key, prefix),
            }
        )
        if key == "server":
            stdin = (root / "docs/snippets/api/stdin.md").read_text()
        else:
            stdin = (
                "Multipart stdin is available on OSS Server. Cloud currently "
                "accepts JSON shell requests.\n\nSee [Send stdin on OSS Server]"
                "(/api/server/streaming#send-stdin) for multipart examples."
            )
        guide = (
            template.replace("{{STDIN_SECTION}}", stdin)
            .replace("{{BASE_URL}}", url)
            .replace("{{API_PREFIX}}", "/" + prefix)
            .replace(
                "{{LINE_ID}}",
                ',"line_id":"line_019a5e2c-7b41-7c3e-9f20-4d8e1a6b5c37"'
                if key == "server"
                else "",
            )
            .replace(
                "{{LINE_NOTE}}",
                "OSS Server includes `line_id` in the result. "
                "Use it to [get the line record]"
                "(/api/server/operations/lines/get-a-line)."
                if key == "server"
                else "",
            )
        )
        outputs[root / f"docs/{prefix}/streaming.mdx"] = guide
    overview = (root / "docs/api/overview.mdx").read_text()
    outputs[root / "docs/api/server/overview.mdx"] = (
        overview.replace("<Tabs>", "<Tabs defaultTabIndex={1}>", 1)
        .replace("](/api/operations/", "](/api/server/operations/")
        .replace("](/api/reference)", "](/api/server/reference)")
        .replace('href="/api/quickstart"', 'href="/api/server/quickstart"')
        .replace('href="/api/reference"', 'href="/api/server/reference"')
        .replace('href="/api/errors"', 'href="/api/server/errors"')
        .replace('title="Cloud quickstart"', 'title="OSS Server quickstart"')
        .replace(
            "Create a hosted workspace", "Create a workspace on your server"
        )
    )
    outputs[root / "docs/docs.json"] = json.dumps(config, indent=2) + "\n"
    return outputs
