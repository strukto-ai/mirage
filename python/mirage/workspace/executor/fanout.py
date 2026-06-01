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

import fnmatch

from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.types import PathSpec
from mirage.workspace.executor.find_action_dispatch import _apply_find_actions
from mirage.workspace.mount import MountRegistry
from mirage.workspace.types import ExecutionNode

_TRAVERSAL_CMDS = frozenset({"find", "tree", "du"})


def _path_segments(path: str) -> list[str]:
    return [s for s in path.strip("/").split("/") if s]


def _should_fan_out(
    cmd_name: str,
    paths: list[PathSpec],
    flag_kwargs: dict,
    registry: MountRegistry,
) -> bool:
    """Whether `cmd` on this path should run across multiple mounts.

    True when the command is in the traversal whitelist (find/tree/du)
    and the path has at least one descendant mount; or for grep with
    -r/-R; or for ls -R. Returns False when there's no descendant
    mount under the path (single-mount dispatch is correct).
    """
    if not paths:
        return False
    target = paths[0].original
    if not registry.descendant_mounts(target):
        return False
    if cmd_name in _TRAVERSAL_CMDS:
        return True
    if cmd_name == "grep":
        return (flag_kwargs.get("r") is True or flag_kwargs.get("R") is True
                or flag_kwargs.get("recursive") is True)
    if cmd_name == "ls":
        return flag_kwargs.get("R") is True
    return False


def _adjust_depth_flags(
    flag_kwargs: dict,
    parent_path: str,
    mount_prefix: str,
) -> dict | None:
    """Adjust find's -maxdepth/-mindepth for a fan-out into a child mount.

    Returns the new kwargs dict, or None if the child mount falls
    outside the depth budget (caller should skip it).
    """
    parent_depth = len(_path_segments(parent_path))
    mount_depth = len(_path_segments(mount_prefix))
    delta = mount_depth - parent_depth
    new = dict(flag_kwargs)
    if "maxdepth" in new:
        try:
            md = int(new["maxdepth"]) - delta
        except (TypeError, ValueError):
            md = None
        if md is not None:
            if md < 0:
                return None
            new["maxdepth"] = str(md)
    if "mindepth" in new:
        try:
            mn = max(0, int(new["mindepth"]) - delta)
            new["mindepth"] = str(mn)
        except (TypeError, ValueError):
            pass
    return new


def _synthesize_find_mount_entries(
    target_path: str,
    descendants: list,
    flag_kwargs: dict,
) -> str:
    """Return synthetic find lines for descendant mount roots.

    `find /` and friends should list mount prefixes as directory
    entries even though no per-mount find emits its own root. Honors
    -maxdepth / -mindepth windows and the -type filter (only injects
    when 'd' or no type filter is set).
    """
    type_filter = flag_kwargs.get("type")
    if type_filter is not None and type_filter != "d":
        return ""
    parent_depth = len(_path_segments(target_path))
    try:
        max_depth = (int(flag_kwargs["maxdepth"])
                     if "maxdepth" in flag_kwargs else None)
    except (TypeError, ValueError):
        max_depth = None
    try:
        min_depth = (int(flag_kwargs["mindepth"])
                     if "mindepth" in flag_kwargs else 0)
    except (TypeError, ValueError):
        min_depth = 0
    name_pat = flag_kwargs.get("name")
    iname_pat = flag_kwargs.get("iname")
    out: list[str] = []
    for m in descendants:
        prefix_no_slash = m.prefix.rstrip("/")
        depth = len(_path_segments(prefix_no_slash)) - parent_depth
        if depth < min_depth:
            continue
        if max_depth is not None and depth > max_depth:
            continue
        base = prefix_no_slash.rsplit("/", 1)[-1] or prefix_no_slash
        if isinstance(name_pat, str) and not fnmatch.fnmatch(base, name_pat):
            continue
        if isinstance(iname_pat, str) and not fnmatch.fnmatch(
                base.lower(), iname_pat.lower()):
            continue
        out.append(prefix_no_slash)
    return "\n".join(out)


async def _filter_under_prefixes(
    stdout: ByteSource,
    descendant_prefixes: list[str],
) -> bytes:
    """Drop lines whose path falls under any descendant mount prefix.

    Path is taken from the start of the line up to the first tab,
    colon, or whitespace (handles find / du / grep output formats).
    Lines that do not start with `/` are passed through.
    """
    data = await materialize(stdout)
    text = data.decode("utf-8", errors="replace")
    out_lines: list[str] = []
    for line in text.split("\n"):
        if line == "":
            continue
        path = line
        for sep in ("\t", ":"):
            if sep in path:
                path = path.split(sep, 1)[0]
                break
        if path.startswith("/"):
            shadowed = False
            for pre in descendant_prefixes:
                if path == pre or path.startswith(pre + "/"):
                    shadowed = True
                    break
            if shadowed:
                continue
        out_lines.append(line)
    return ("\n".join(out_lines) + "\n").encode("utf-8") if out_lines else b""


async def _fan_out_traversal(
    cmd_name: str,
    paths: list[PathSpec],
    texts: list[str],
    flag_kwargs: dict,
    registry: MountRegistry,
    primary_mount: object,
    cwd: str,
    cmd_str: str,
    stdin: ByteSource | None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run a traversal command across the parent mount + descendant mounts.

    Each mount runs the command with its own root as the path argument
    (depth flags adjusted for find/tree). Outputs are concatenated in
    mount-prefix-sorted order. The parent mount's output is filtered to
    drop lines that fall under any descendant mount (avoids duplicates
    when the parent's resource has shadowed keys).

    For `find`, mount-prefix paths themselves are injected as synthetic
    directory entries (subject to depth and -type filters) because
    mirage's per-mount find doesn't emit the path argument itself.
    """
    target_path = paths[0].original
    descendants = registry.descendant_mounts(target_path)
    descendant_prefixes = [m.prefix.rstrip("/") for m in descendants]

    all_stdout: list[bytes] = []
    merged_io = IOResult()
    final_exit = 0
    success_seen = False

    for mount in [primary_mount] + list(descendants):
        if mount is primary_mount:
            sub_paths = list(paths)
            sub_flags = dict(flag_kwargs)
        else:
            mount_root = mount.prefix.rstrip("/") or "/"
            sub_flags = _adjust_depth_flags(flag_kwargs, target_path,
                                            mount.prefix)
            if sub_flags is None:
                continue
            sub_paths = [
                PathSpec(original=mount_root,
                         directory=mount_root,
                         resolved=True)
            ]
        try:
            stdout, io = await mount.execute_cmd(cmd_name,
                                                 sub_paths,
                                                 list(texts),
                                                 sub_flags,
                                                 stdin=stdin,
                                                 cwd=cwd)
        except Exception:
            continue

        if mount is primary_mount and descendant_prefixes and stdout:
            stdout = await _filter_under_prefixes(stdout, descendant_prefixes)

        if stdout is not None:
            data = await materialize(stdout)
            if data:
                all_stdout.append(data)
        if io.exit_code == 0:
            success_seen = True
        elif io.exit_code != 0 and final_exit == 0:
            final_exit = io.exit_code
        merged_io = await merged_io.merge(io)

    if cmd_name == "find":
        synthetic = _synthesize_find_mount_entries(target_path, descendants,
                                                   flag_kwargs)
        if synthetic:
            all_stdout.append(synthetic.encode("utf-8"))

    combined: ByteSource | None
    if all_stdout:
        combined = b"\n".join(b.rstrip(b"\n") for b in all_stdout) + b"\n"
    else:
        combined = None
    final_io_exit = 0 if success_seen else final_exit

    if cmd_name == "find":
        combined, action_err = await _apply_find_actions(
            combined, flag_kwargs, registry, cwd)
        if action_err:
            existing = (await materialize(merged_io.stderr)
                        if merged_io.stderr else b"")
            merged_io.stderr = existing + action_err
            if final_io_exit == 0:
                final_io_exit = 1

    merged_io.exit_code = final_io_exit
    exec_node = ExecutionNode(command=cmd_str,
                              exit_code=final_io_exit,
                              stderr=merged_io.stderr)
    return combined, merged_io, exec_node
