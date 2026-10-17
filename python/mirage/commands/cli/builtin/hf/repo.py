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

from mirage.commands.cli.builtin.hf.accessor import (
    repo_type_of,
    require_operands,
    require_token,
    text_out,
)
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.core.hf_hub.admin import create_repo, create_tag, list_tags
from mirage.core.hf_hub.admin import delete_tag as delete_tag_api
from mirage.core.hf_hub.client import repo_url
from mirage.core.hf_hub.config import HfConfig
from mirage.core.hf_hub.constants import DEFAULT_REVISION
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import PathSpec


async def create_cmd(
    config: HfConfig, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Create a repository on the Hub."""
    require_operands(texts, ["repo_id"])
    require_token(config, "repo create")
    fl = FlagView(ctx.flags)
    repo_id = texts[0]
    repo_type = repo_type_of(fl)
    sdk = fl.as_str("space_sdk")
    if repo_type == "space" and not sdk:
        raise UsageError(
            "creating a space requires --space_sdk (gradio, streamlit, "
            "docker or static)"
        )
    result = await create_repo(
        config,
        repo_id,
        repo_type,
        private=bool(fl.as_bool("private")),
        space_sdk=sdk,
        exist_ok=bool(fl.as_bool("exist_ok")),
        resource_group_id=fl.as_str("resource_group_id"),
    )
    url = result.get("url")
    return text_out(
        f"{url}\n"
        if isinstance(url, str)
        else f"{repo_url(config.endpoint, repo_type, repo_id)}\n"
    )


async def tag_create_cmd(
    config: HfConfig, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Tag a revision of a repository."""
    require_operands(texts, ["repo_id", "tag"])
    require_token(config, "repo tag create")
    fl = FlagView(ctx.flags)
    repo_id, tag = texts[0], texts[1]
    await create_tag(
        config,
        repo_id,
        tag,
        repo_type_of(fl),
        revision=fl.as_str("revision") or DEFAULT_REVISION,
        message=fl.as_str("message"),
    )
    return text_out(f"Tag {tag} created on {repo_id}\n")


async def tag_list_cmd(
    config: HfConfig, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """List a repository's tags."""
    require_operands(texts, ["repo_id"])
    fl = FlagView(ctx.flags)
    repo_id = texts[0]
    tags = await list_tags(config, repo_id, repo_type_of(fl))
    return text_out("".join(f"{name}\n" for name in tags))


async def confirmed(ctx: Context) -> bool:
    """Whether the line agreed to a destructive action.

    Upstream asks on stdin and takes ``-y`` to skip the question, so
    both routes are honored: ``-y`` short-circuits, and otherwise the
    piped answer is read the way ``input()`` would read it. A line with
    nothing piped is the case upstream cannot reach, since a workspace
    has no terminal to fall back to, and it declines rather than
    assuming yes.

    Args:
        ctx (Context): the invocation's context.

    Returns:
        bool: whether to go ahead.
    """
    if FlagView(ctx.flags).as_bool("yes"):
        return True
    if ctx.stdin is None:
        return False
    answer = (await materialize(ctx.stdin)).decode(errors="replace")
    return answer.strip().lower() in {"y", "yes"}


async def tag_delete_cmd(
    config: HfConfig, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Delete a tag from a repository.

    Upstream asks for confirmation before deleting; a workspace has no
    terminal, so the answer arrives either as ``-y`` or on stdin.
    """
    require_operands(texts, ["repo_id", "tag"])
    require_token(config, "repo tag delete")
    fl = FlagView(ctx.flags)
    repo_id, tag = texts[0], texts[1]
    if not await confirmed(ctx):
        raise UsageError(
            f"deleting tag {tag} needs -y, or y on stdin: there is no "
            "terminal to confirm on"
        )
    await delete_tag_api(config, repo_id, tag, repo_type_of(fl))
    return text_out(f"Tag {tag} deleted on {repo_id}\n")
