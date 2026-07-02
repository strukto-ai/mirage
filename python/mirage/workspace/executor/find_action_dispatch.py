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

from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.types import PathSpec
from mirage.workspace.mount import MountRegistry


async def _apply_find_actions(
    stdout: ByteSource | None,
    flag_kwargs: dict,
    registry: MountRegistry,
    cwd: str,
) -> tuple[ByteSource | None, bytes]:
    """Apply find action flags (-delete / -print0 / -ls) to find output.

    Per-resource find handlers only emit matched paths. This dispatcher
    layer reads action flags and dispatches the side effect (rm for
    -delete, ls -ld for -ls) per match through the appropriate mount,
    then re-formats the output.

    Args:
        stdout (ByteSource | None): newline-joined match list from find.
        flag_kwargs (dict): parsed flag dict; action flags read here.
        registry (MountRegistry): used to route per-match dispatch.
        cwd (str): cwd forwarded to per-match sub-dispatch.
    """
    has_delete = flag_kwargs.get("delete") is True
    has_print0 = flag_kwargs.get("print0") is True
    has_ls = flag_kwargs.get("ls") is True
    has_print = flag_kwargs.get("print") is True

    if not (has_delete or has_print0 or has_ls):
        return stdout, b""
    if stdout is None:
        return stdout, b""

    text = (await materialize(stdout)).decode("utf-8", errors="replace")
    matches = [p for p in text.split("\n") if p]
    errors: list[bytes] = []

    if has_delete:
        # Deepest-first so children are removed before parents.
        # Skip mount roots: mount points are structural, not
        # unlinkable entries — refusing matches Unix semantics.
        deletable = [p for p in matches if not registry.is_mount_root(p)]
        ordered = sorted(deletable, key=lambda p: p.count("/"), reverse=True)
        for path in ordered:
            try:
                mount = registry.mount_for(path)
            except ValueError:
                msg = f"find: cannot delete '{path}': no mount\n"
                errors.append(msg.encode())
                continue
            ps = PathSpec(
                virtual=path,
                directory=path[:path.rfind("/") + 1] or "/",
                resource_path="",
                resolved=True,
            )
            try:
                _, rm_io = await mount.execute_cmd("rm", [ps], [], {},
                                                   stdin=None,
                                                   cwd=cwd)
            except (FileNotFoundError, NotADirectoryError, PermissionError,
                    ValueError) as exc:
                errors.append(
                    f"find: cannot delete '{path}': {exc}\n".encode())
                continue
            if rm_io.exit_code != 0:
                err = await materialize(rm_io.stderr) if rm_io.stderr else b""
                if not err:
                    err = f"find: cannot delete '{path}'\n".encode()
                errors.append(err)
        # GNU find: -delete suppresses default print unless -print also set.
        output_matches = matches if has_print else []
    elif has_ls:
        output_matches = []
        for path in matches:
            try:
                mount = registry.mount_for(path)
            except ValueError:
                errors.append(f"find: cannot ls '{path}': no mount\n".encode())
                continue
            ps = PathSpec(
                virtual=path,
                directory=path[:path.rfind("/") + 1] or "/",
                resource_path="",
                resolved=True,
            )
            try:
                ls_out, _ = await mount.execute_cmd("ls", [ps], [], {
                    "args_l": True,
                    "d": True
                },
                                                    stdin=None,
                                                    cwd=cwd)
            except (FileNotFoundError, NotADirectoryError, PermissionError,
                    ValueError) as exc:
                errors.append(f"find: cannot ls '{path}': {exc}\n".encode())
                continue
            if ls_out is not None:
                line = (await materialize(ls_out)).decode(
                    "utf-8", errors="replace").rstrip("\n")
                if line:
                    output_matches.append(line)
    else:
        output_matches = matches

    err_blob = b"".join(errors)
    if not output_matches:
        return None, err_blob

    if has_print0:
        body = b"\x00".join(m.encode("utf-8")
                            for m in output_matches) + b"\x00"
    else:
        body = ("\n".join(output_matches) + "\n").encode("utf-8")
    return body, err_blob
