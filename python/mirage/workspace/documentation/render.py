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

from mirage.commands.cli.types import CLISpec
from mirage.commands.cli.walk import node_help, owns_argv
from mirage.commands.spec.types import UsageStyle
from mirage.context import effective_path_mode
from mirage.types import MountMode
from mirage.utils.hidden import is_glob, path_visible
from mirage.workspace.lookup.lookup import command_visible, verb_visible
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.session.access import io_context
from mirage.workspace.session.session import SessionState

MODE_LINES = {
    MountMode.READ: "read-only",
    MountMode.WRITE: "read-write",
    MountMode.EXEC: "read-write; python3 and js can run code here",
}


def vfs_md(registry: MountRegistry, session: SessionState) -> str:
    """Describe the current namespace without enumerating backend data.

    Args:
        registry (MountRegistry): the workspace's live mount registry.
        session (SessionState): the session bound by the caller.
    """
    parts = [
        "# Virtual filesystem",
        "Paths are inside the MIRAGE workspace. "
        "Access is checked for each operation; "
        "command policies may impose further restrictions.",
    ]
    vis = session.visibility
    for mount in sorted(registry.visible_mounts(), key=lambda m: m.prefix):
        prefix = mount.prefix.rstrip("/") or "/"
        if (
            prefix in {"/dev", "/usr/bin", "/.bash_history"}
            or mount.vfs.name in {"dev", "history", "bin", "document"}
            or not path_visible(vis, prefix)
        ):
            continue
        mode = effective_path_mode(
            prefix, mount.prefix, mount.mode, io_context(session)
        )
        parts.append(
            f"## `{prefix}`\n\nBackend: `{mount.vfs.name}`. Access: {MODE_LINES[mode]}."
        )
        # Backend prose is not a permission document. Under a restricted
        # view it can advertise hidden paths or verbs, so describe only
        # structured facts rather than interpolate unrestricted guidance.
        if (
            vis.paths is None
            and vis.shown is None
            and vis.commands is None
            and session.commands is None
            and mode == mount.mode
        ):
            if mount.vfs.prompt:
                parts.append(
                    mount.vfs.prompt.replace("{prefix}", prefix).strip()
                )
            if mode != MountMode.READ and mount.vfs.write_prompt:
                parts.append(
                    mount.vfs.write_prompt.replace("{prefix}", prefix).strip()
                )
        if vis.shown is not None:
            for entry in vis.shown.entries:
                if (
                    entry.mode is None
                    or is_glob(entry.path)
                    or not path_visible(vis, entry.path)
                ):
                    continue
                if registry.try_mount_for(entry.path) is mount:
                    effective = effective_path_mode(
                        entry.path,
                        mount.prefix,
                        mount.mode,
                        io_context(session),
                    )
                    parts.append(f"- `{entry.path}`: {MODE_LINES[effective]}.")
    if command_visible("man", session):
        parts.append(
            "Use `man` to discover visible commands and registered CLIs, "
            "and `man <cmd>` or `<cmd> --help` for usage."
        )
    return "\n\n".join(parts) + "\n"


def cli_pages(
    head: str,
    node: CLISpec,
    session: SessionState,
    style: UsageStyle,
    path: tuple[str, ...] = (),
) -> list[str]:
    if not verb_visible(head, path, session):
        return []
    name = " ".join((head, *path))
    help_text = node_help(
        name,
        node,
        style,
        visible=lambda child: verb_visible(head, (*path, child), session),
    ).rstrip()
    fence = "`" * max(
        3,
        max(
            (len(s) for s in help_text.split("\n") if s and set(s) == {"`"}),
            default=0,
        )
        + 1,
    )
    pages = [f"## `{name}`\n\n{fence}text\n{help_text}\n{fence}"]
    if owns_argv(node):
        pages.append(
            "This program parses its own arguments; "
            "only its registered description is available here."
        )
    for child in node.subcommands:
        pages.extend(
            cli_pages(head, child, session, style, (*path, child.name))
        )
    return pages


def skill_md(registry: MountRegistry, session: SessionState) -> str:
    """Render one self-contained skill from visible registered CLI specs.

    Args:
        registry (MountRegistry): the workspace's live CLI registry.
        session (SessionState): the session whose CLI tree is visible.
    """
    parts = [
        "---\nname: mirage\ndescription: Work with data and "
        "registered commands inside a MIRAGE workspace.\n---",
        "# MIRAGE",
        "Run these commands in the MIRAGE terminal. "
        "Paths refer to its virtual filesystem. "
        "The available commands and access can change with the session profile; "
        "permissions are checked on every invocation.",
    ]
    for head, install in sorted(registry.clis.items().items()):
        if command_visible(head, session):
            parts.extend(
                cli_pages(
                    head, install.spec, session, install.spec.usage_style
                )
            )
    if len(parts) == 3:
        parts.append("No registered CLIs are visible in this session.")
    return "\n\n".join(parts) + "\n"
