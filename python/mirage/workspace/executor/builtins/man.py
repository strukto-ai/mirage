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

from dataclasses import dataclass

from mirage.commands.config import RegisteredCommand
from mirage.commands.spec import SPECS, CommandSpec
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.mount.registry import DEV_PREFIX, MountRegistry
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


@dataclass
class _ManHit:
    mount: MountEntry
    cmd: RegisteredCommand
    is_general: bool


def _collect_man_hits(name: str, registry: MountRegistry) -> list[_ManHit]:
    hits: list[_ManHit] = []
    for mount in registry.mounts():
        if mount.prefix == DEV_PREFIX:
            continue
        cmd = mount.resolve_command(name)
        if cmd is None:
            continue
        hits.append(
            _ManHit(mount=mount,
                    cmd=cmd,
                    is_general=mount.is_general_command(name)))
    return hits


def _render_options_table(spec: CommandSpec) -> list[str]:
    if not spec.options:
        return []
    lines: list[str] = []
    lines.append("## OPTIONS")
    lines.append("")
    lines.append("| short | long | value | description |")
    lines.append("| ----- | ---- | ----- | ----------- |")
    for opt in spec.options:
        short = opt.short if opt.short is not None else ""
        long = opt.long if opt.long is not None else ""
        desc = opt.description if opt.description is not None else ""
        lines.append(f"| {short} | {long} | {opt.value_kind.value} | {desc} |")
    lines.append("")
    return lines


def _render_man_entry(name: str, hits: list[_ManHit]) -> str:
    first = hits[0]
    spec = first.cmd.spec
    lines: list[str] = []
    lines.append(f"# {name}")
    lines.append("")
    lines.append(spec.description if spec.
                 description is not None else "(no description)")
    lines.append("")
    lines.extend(_render_options_table(spec))
    lines.append("## RESOURCES")
    lines.append("")
    seen: set[str] = set()
    has_general = False
    rows: list[str] = []
    for h in hits:
        if h.is_general:
            has_general = True
            continue
        kind = h.mount.resource.name
        filetype = h.cmd.filetype
        key = f"{kind}\x00{filetype or ''}"
        if key in seen:
            continue
        seen.add(key)
        if filetype is not None:
            rows.append(f"- {kind} (filetype: {filetype})")
        else:
            rows.append(f"- {kind}")
    rows.sort()
    if has_general:
        lines.append("- general")
    for r in rows:
        lines.append(r)
    return "\n".join(lines) + "\n"


_SHELL_BUILTIN_MAN: dict[str, str] = {
    "bash": "bash",
    "sh": "bash",
}


def _render_shell_builtin_man(name: str, spec: CommandSpec) -> str:
    lines: list[str] = []
    lines.append(f"# {name}")
    lines.append("")
    lines.append(spec.description if spec.
                 description is not None else "(no description)")
    lines.append("")
    lines.extend(_render_options_table(spec))
    lines.append("## RESOURCES")
    lines.append("")
    lines.append("- shell builtin")
    return "\n".join(lines) + "\n"


def _render_man_index(session: Session, registry: MountRegistry) -> str:
    by_kind: dict[str, MountEntry] = {}
    for m in registry.mounts():
        if m.prefix == DEV_PREFIX:
            continue
        if m.resource.name not in by_kind:
            by_kind[m.resource.name] = m
    try:
        cwd_mount: MountEntry | None = registry.mount_for(session.cwd)
    except ValueError:
        cwd_mount = None
    cwd_kind: str | None = None
    if cwd_mount is not None and cwd_mount.prefix != DEV_PREFIX:
        cwd_kind = cwd_mount.resource.name

    kinds = sorted(by_kind.keys())
    ordered: list[str] = []
    if cwd_kind is not None and cwd_kind in by_kind:
        ordered.append(cwd_kind)
    for k in kinds:
        if k == cwd_kind:
            continue
        ordered.append(k)

    lines: list[str] = []
    general_seen: dict[str, RegisteredCommand] = {}
    for kind in ordered:
        m = by_kind[kind]
        lines.append(f"# {kind}")
        lines.append("")
        all_cmds = m.all_commands()
        resource_cmds = sorted(
            (c for c in all_cmds if not m.is_general_command(c.name)),
            key=lambda c: c.name,
        )
        for cmd in resource_cmds:
            desc = (cmd.spec.description if cmd.spec.description is not None
                    else "(no description)")
            lines.append(f"- {cmd.name} \u2014 {desc}")
        for cmd in all_cmds:
            if (m.is_general_command(cmd.name)
                    and cmd.name not in general_seen):
                general_seen[cmd.name] = cmd
        lines.append("")
    lines.append("# general")
    lines.append("")
    for name in sorted(general_seen):
        cmd = general_seen[name]
        desc = (cmd.spec.description
                if cmd.spec.description is not None else "(no description)")
        lines.append(f"- {name} \u2014 {desc}")
    return "\n".join(lines) + "\n"


async def handle_man(
    args: list[str],
    session: Session,
    registry: MountRegistry,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    if not args:
        out = _render_man_index(session, registry).encode()
        return out, IOResult(), ExecutionNode(command="man", exit_code=0)
    name = args[0]
    hits = _collect_man_hits(name, registry)
    if not hits:
        spec_key = _SHELL_BUILTIN_MAN.get(name)
        spec = SPECS.get(spec_key) if spec_key is not None else None
        if spec is not None:
            out = _render_shell_builtin_man(name, spec).encode()
            return out, IOResult(), ExecutionNode(command=f"man {name}",
                                                  exit_code=0)
        err = f"man: no entry for {name}\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=f"man {name}",
                                                         exit_code=1,
                                                         stderr=err)
    out = _render_man_entry(name, hits).encode()
    return out, IOResult(), ExecutionNode(command=f"man {name}", exit_code=0)
