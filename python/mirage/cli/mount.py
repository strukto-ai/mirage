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

import hashlib
import json
import os
import re
from typing import Any

import typer

from mirage.cli.client import make_client
from mirage.cli.output import emit, handle_response

app = typer.Typer(help="Mount a single backend as a live FUSE tree.")

SPEC_ENV = "MIRAGE_MOUNT_SPEC"

_ID_PREFIX = "mnt-"


def mount_id(prefix: str) -> str:
    """Deterministic workspace id for one mounted prefix.

    Args:
        prefix (str): the virtual mount prefix, e.g. ``/data``.
    """
    slug = re.sub(r"[^a-z0-9]+", "-", prefix.strip("/").lower()).strip("-")
    digest = hashlib.sha1(prefix.encode()).hexdigest()[:6]
    return f"{_ID_PREFIX}{slug or 'root'}-{digest}"


def _read_spec() -> dict[str, Any]:
    raw = os.environ.get(SPEC_ENV)
    if not raw:
        raise typer.BadParameter(
            f"missing {SPEC_ENV}: pass the mount spec as JSON "
            '{"resource": <name>, "config": {...}} in the environment')
    try:
        spec = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise typer.BadParameter(f"{SPEC_ENV} is not valid JSON: {exc}")
    if not isinstance(spec, dict) or "resource" not in spec:
        raise typer.BadParameter(
            f'{SPEC_ENV} must be {{"resource": <name>, "config": {{...}}}}')
    return spec


@app.command("add")
def add_cmd(
    prefix: str = typer.Argument(...,
                                 help="Virtual mount prefix, e.g. /data."),
    fuse: str = typer.Option(...,
                             "--fuse",
                             help="Filesystem path to FUSE-mount at."),
) -> None:
    """Mount one backend at PREFIX, spec read from MIRAGE_MOUNT_SPEC.

    Creates a dedicated single-mount workspace in the daemon (spawned
    if needed) whose fuse target is --fuse, so each mount can be added
    and removed independently. Replaces an existing mount of the same
    prefix.
    """
    spec = _read_spec()
    workspace_id = mount_id(prefix)
    mount_block: dict[str, Any] = {
        "resource": spec["resource"],
        "config": spec.get("config", {}),
        "fuse": fuse,
    }
    body = {
        "id": workspace_id,
        "config": {
            "mode": "EXEC",
            "mounts": {
                prefix: mount_block
            }
        },
    }
    with make_client() as client:
        client.ensure_running()
        # Idempotent replace: a stale mount of the same prefix (e.g. a
        # changed config) is torn down before the new one comes up.
        client.request("DELETE", f"/v1/workspaces/{workspace_id}")
        r = client.request("POST", "/v1/workspaces", json=body)
    handle_response(r)
    emit({
        "prefix": prefix,
        "fuse": fuse,
        "workspace": workspace_id
    },
         human=lambda _d: f"mounted {prefix} at {fuse} ({workspace_id})")


_REMOVE_PREFIX = typer.Argument(..., help="Virtual mount prefix to unmount.")


@app.command("remove")
def remove_cmd(prefix: str = _REMOVE_PREFIX) -> None:
    """Unmount PREFIX: delete its dedicated workspace, if present."""
    workspace_id = mount_id(prefix)
    with make_client() as client:
        client.ensure_running()
        r = client.request("DELETE", f"/v1/workspaces/{workspace_id}")
    if r.status_code == 404:
        emit({
            "prefix": prefix,
            "removed": False
        },
             human=lambda _d: f"{prefix} was not mounted")
        return
    handle_response(r)
    emit({
        "prefix": prefix,
        "removed": True
    },
         human=lambda _d: f"unmounted {prefix}")


@app.command("list")
def list_cmd() -> None:
    """List prefixes mounted through `mirage mount add`."""
    with make_client() as client:
        client.ensure_running()
        r = client.request("GET", "/v1/workspaces")
    items = handle_response(r)
    mounted = [
        item for item in items if isinstance(item, dict)
        and str(item.get("id", "")).startswith(_ID_PREFIX)
    ]
    emit(mounted,
         human=lambda rows: "\n".join(str(row.get("id", ""))
                                      for row in rows) or "(no mounts)")
