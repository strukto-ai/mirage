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

import base64
from dataclasses import dataclass
from typing import Any, Literal

from mirage.commands.cli.builtin.gh.accessor import (
    camel,
    check_host,
    csv_values,
    gh_bool,
    gh_repo,
    json_fields,
    list_limit,
    text_out,
    typed_out,
    web_origin,
)
from mirage.commands.cli.builtin.gh.constants import REPO_EDIT_FIELDS
from mirage.commands.cli.builtin.gh.shape import (
    ListOf,
    Shape,
    exported,
    pointer,
    struct,
)
from mirage.commands.cli.builtin.git import GIT
from mirage.commands.cli.builtin.git.clone import clone as git_clone
from mirage.commands.cli.builtin.git.util import split_marked
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.cli.walk import find_node
from mirage.commands.errors import UsageError
from mirage.commands.spec.constants import flag_kwarg_name
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.parser import parse_command, parse_to_kwargs
from mirage.commands.spec.types import FlagValue
from mirage.core.github.config import GhConfig
from mirage.core.github.repo import (
    RepoRef,
    create_repo,
    delete_repo,
    edit_repo,
    fork_repo,
    list_repos,
    list_repository_fields,
    login,
    parse_repo,
    read_readme,
    rename_repo,
    repo_host,
    repo_topics,
    repository_fields,
    set_repo_topics,
    view_repo,
)
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue

_OWNER = struct(("id", "string"), ("login", "string"))
_USER = struct(
    ("id", "string"),
    ("login", "string"),
    ("name", "string"),
    ("databaseId", "int"),
)
_COUNT = struct(("totalCount", "int"))
# gh prints a related repository (a fork's parent, a template) as three
# facts.
_RELATED = pointer(("id", "string"), ("name", "string"), ("owner", _OWNER))


@dataclass(frozen=True, slots=True)
class RepoField:
    """One ``--json`` field: the GraphQL selection gh sends for it and how
    the answer prints.

    Args:
        select (str): the selection inside ``repository { }``.
        shape (Shape): the Go type gh decodes the answer into.
        unwrap (str | None): gh's own flattening of a connection: its
            ``nodes``, its ``edges``, or the topic inside each topic
            node, which prints null rather than ``[]`` for a repository
            with none.
    """

    select: str
    shape: Shape
    unwrap: Literal["nodes", "edges", "topics"] | None = None


def _plain(name: str, shape: Shape) -> tuple[str, RepoField]:
    return name, RepoField(name, shape)


# Every field `gh repo view --json` and `gh repo list --json` accept in
# gh 2.85, each with the selection gh put on the wire for it (captured
# with GH_DEBUG=api) and the shape of gh's own Repository type.
REPO_FIELD_TABLE: dict[str, RepoField] = dict(
    [
        _plain("archivedAt", "raw"),
        (
            "assignableUsers",
            RepoField(
                "assignableUsers(first:100){nodes{id,login,name}}",
                ListOf(_USER),
                "nodes",
            ),
        ),
        (
            "codeOfConduct",
            RepoField(
                "codeOfConduct{key,name,url}",
                pointer(
                    ("key", "string"), ("name", "string"), ("url", "string")
                ),
            ),
        ),
        (
            "contactLinks",
            RepoField(
                "contactLinks{about,name,url}",
                ListOf(
                    struct(
                        ("about", "string"),
                        ("name", "string"),
                        ("url", "string"),
                    )
                ),
            ),
        ),
        _plain("createdAt", "time"),
        (
            "defaultBranchRef",
            RepoField("defaultBranchRef{name}", struct(("name", "string"))),
        ),
        _plain("deleteBranchOnMerge", "bool"),
        _plain("description", "string"),
        _plain("diskUsage", "int"),
        _plain("forkCount", "int"),
        (
            "fundingLinks",
            RepoField(
                "fundingLinks{platform,url}",
                ListOf(struct(("platform", "string"), ("url", "string"))),
            ),
        ),
        _plain("hasDiscussionsEnabled", "bool"),
        _plain("hasIssuesEnabled", "bool"),
        _plain("hasProjectsEnabled", "bool"),
        _plain("hasWikiEnabled", "bool"),
        _plain("homepageUrl", "string"),
        _plain("id", "string"),
        _plain("isArchived", "bool"),
        _plain("isBlankIssuesEnabled", "bool"),
        _plain("isEmpty", "bool"),
        _plain("isFork", "bool"),
        _plain("isInOrganization", "bool"),
        _plain("isMirror", "bool"),
        _plain("isPrivate", "bool"),
        _plain("isSecurityPolicyEnabled", "bool"),
        _plain("isTemplate", "bool"),
        _plain("isUserConfigurationRepository", "bool"),
        (
            "issueTemplates",
            RepoField(
                "issueTemplates{name,title,body,about}",
                ListOf(
                    struct(
                        ("name", "string"),
                        ("title", "string"),
                        ("body", "string"),
                        ("about", "string"),
                    )
                ),
            ),
        ),
        ("issues", RepoField("issues(states:OPEN){totalCount}", _COUNT)),
        (
            "labels",
            RepoField(
                "labels(first:100){nodes{id,color,name,description}}",
                ListOf(
                    struct(
                        ("id", "string"),
                        ("name", "string"),
                        ("description", "string"),
                        ("color", "string"),
                    )
                ),
                "nodes",
            ),
        ),
        (
            "languages",
            RepoField(
                "languages(first:100){edges{size,node{name}}}",
                ListOf(
                    struct(
                        ("size", "int"), ("node", struct(("name", "string")))
                    )
                ),
                "edges",
            ),
        ),
        (
            "latestRelease",
            RepoField(
                "latestRelease{publishedAt,tagName,name,url}",
                pointer(
                    ("name", "string"),
                    ("tagName", "string"),
                    ("url", "string"),
                    ("publishedAt", "time"),
                ),
            ),
        ),
        (
            "licenseInfo",
            RepoField(
                "licenseInfo{key,name,nickname}",
                pointer(
                    ("key", "string"),
                    ("name", "string"),
                    ("nickname", "string"),
                ),
            ),
        ),
        (
            "mentionableUsers",
            RepoField(
                "mentionableUsers(first:100){nodes{id,login,name}}",
                ListOf(_USER),
                "nodes",
            ),
        ),
        _plain("mergeCommitAllowed", "bool"),
        (
            "milestones",
            RepoField(
                "milestones(first:100,states:OPEN)"
                "{nodes{number,title,description,dueOn}}",
                ListOf(
                    struct(
                        ("number", "int"),
                        ("title", "string"),
                        ("description", "string"),
                        ("dueOn", "raw"),
                    )
                ),
                "nodes",
            ),
        ),
        _plain("mirrorUrl", "string"),
        _plain("name", "string"),
        _plain("nameWithOwner", "string"),
        _plain("openGraphImageUrl", "string"),
        ("owner", RepoField("owner{id,login}", _OWNER)),
        ("parent", RepoField("parent{id,name,owner{id,login}}", _RELATED)),
        (
            "primaryLanguage",
            RepoField("primaryLanguage{name}", pointer(("name", "string"))),
        ),
        (
            "projects",
            RepoField(
                "projects(first:100,states:OPEN)"
                "{nodes{id,name,number,body,resourcePath}}",
                ListOf(
                    struct(
                        ("id", "string"),
                        ("name", "string"),
                        ("number", "int"),
                        ("resourcePath", "string"),
                    )
                ),
                "nodes",
            ),
        ),
        # gh has no flattening for this one, so it prints its Go struct as
        # is: the untagged `Nodes` field under its own capitalised name.
        (
            "projectsV2",
            RepoField(
                'projectsV2(first:100,query:"is:open")'
                "{nodes{id,number,title,resourcePath,closed,url}}",
                struct(
                    (
                        "Nodes",
                        ListOf(
                            struct(
                                ("id", "string"),
                                ("title", "string"),
                                ("number", "int"),
                                ("resourcePath", "string"),
                                ("closed", "bool"),
                                ("url", "string"),
                            )
                        ),
                        "nodes",
                    )
                ),
            ),
        ),
        (
            "pullRequestTemplates",
            RepoField(
                "pullRequestTemplates{body,filename}",
                ListOf(struct(("filename", "string"), ("body", "string"))),
            ),
        ),
        (
            "pullRequests",
            RepoField("pullRequests(states:OPEN){totalCount}", _COUNT),
        ),
        _plain("pushedAt", "raw"),
        _plain("rebaseMergeAllowed", "bool"),
        (
            "repositoryTopics",
            RepoField(
                "repositoryTopics(first:100){nodes{topic{name}}}",
                ListOf(struct(("name", "string"))),
                "topics",
            ),
        ),
        _plain("securityPolicyUrl", "string"),
        _plain("squashMergeAllowed", "bool"),
        _plain("sshUrl", "string"),
        _plain("stargazerCount", "int"),
        (
            "templateRepository",
            RepoField("templateRepository{id,name,owner{id,login}}", _RELATED),
        ),
        _plain("updatedAt", "time"),
        _plain("url", "string"),
        _plain("usesCustomOpenGraphImage", "bool"),
        _plain("viewerCanAdminister", "bool"),
        _plain("viewerDefaultCommitEmail", "string"),
        _plain("viewerDefaultMergeMethod", "string"),
        _plain("viewerHasStarred", "bool"),
        _plain("viewerPermission", "string"),
        _plain("viewerPossibleCommitEmails", ListOf("string")),
        _plain("viewerSubscription", "string"),
        _plain("visibility", "string"),
        ("watchers", RepoField("watchers{totalCount}", _COUNT)),
    ]
)

REPO_FIELDS = tuple(REPO_FIELD_TABLE)


def _repo_selection(fields: list[str]) -> str:
    """The GraphQL selection for the fields a line asked for, in its
    order.

    Args:
        fields (list[str]): the ``--json`` fields.
    """
    return ",".join(
        REPO_FIELD_TABLE[field].select for field in dict.fromkeys(fields)
    )


def _exported_repo(node: dict[str, Any], fields: list[str]) -> dict[str, Any]:
    """One repository's answer as gh exports the fields asked for.

    Args:
        node (dict[str, Any]): the GraphQL ``Repository``.
        fields (list[str]): the ``--json`` fields.
    """
    row: dict[str, Any] = {}
    for field in fields:
        spec = REPO_FIELD_TABLE[field]
        value = node.get(field)
        connection = value if isinstance(value, dict) else {}
        if spec.unwrap == "nodes":
            value = connection.get("nodes")
        elif spec.unwrap == "edges":
            value = connection.get("edges")
        elif spec.unwrap == "topics":
            topics = [
                item.get("topic") for item in connection.get("nodes") or []
            ]
            value = topics or None
        row[field] = exported(value, spec.shape)
    return row


def _repo(value: Any) -> dict[str, Any]:
    row = camel(value)
    result = row if isinstance(row, dict) else {}
    if "fullName" in result:
        result["nameWithOwner"] = result.pop("fullName")
    if "defaultBranch" in result:
        result["defaultBranchRef"] = {"name": result.pop("defaultBranch")}
    if "private" in result:
        result["isPrivate"] = result.pop("private")
    if "fork" in result:
        result["isFork"] = result.pop("fork")
    owner = result.get("owner")
    if isinstance(owner, dict) and "login" not in owner and "name" in owner:
        owner["login"] = owner["name"]
    return result


def summary(repo: JsonValue, readme: str | None) -> str:
    """gh's own text view of a repository.

    Two tab-separated header lines and then the README verbatim, with the
    `--` separator omitted entirely when there is no README. Probed
    against gh 2.85, whose description line is present and empty for a
    repository that has none.

    Args:
        repo (JsonValue): the REST repository object.
        readme (str | None): the decoded README, None when absent.

    Returns:
        str: what gh prints.
    """
    fields = repo if isinstance(repo, dict) else {}
    name = fields.get("full_name")
    description = fields.get("description")
    head = (
        f"name:\t{name if isinstance(name, str) else ''}\n"
        f"description:\t"
        f"{description if isinstance(description, str) else ''}\n"
    )
    if readme is None:
        return head
    return f"{head}--\n{readme}"


async def view(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    """``gh repo view``.

    With ``--json`` it asks GraphQL for exactly the fields named, the
    way gh does, so every field gh accepts is answered in gh's own
    shape; the text view reads the REST object and the README.

    Args:
        inv (CLIInvocation[GhConfig]): the line's invocation record.
    """
    fl = FlagView(inv.flags)
    operand = inv.texts[0] if inv.texts else None
    ref = gh_repo(inv.config, operand or fl.as_str("repo"))
    fields = json_fields(fl, REPO_FIELDS)
    if fields is not None:
        node = await repository_fields(
            inv.config, ref, _repo_selection(fields)
        )
        return await typed_out(
            _exported_repo(node, fields), fl, "", REPO_FIELDS
        )
    repo = await view_repo(inv.config, ref)
    return await typed_out(
        repo,
        fl,
        summary(repo, await read_readme(inv.config, ref)),
        REPO_FIELDS,
    )


async def list_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    """``gh repo list``, over GraphQL for ``--json`` as ``view`` is.

    Args:
        inv (CLIInvocation[GhConfig]): the line's invocation record.
    """
    fl = FlagView(inv.flags)
    owner = inv.texts[0] if inv.texts else None
    limit = list_limit(fl, 30)
    fields = json_fields(fl, REPO_FIELDS)
    if fields is not None:
        nodes = await list_repository_fields(
            inv.config, owner, limit, _repo_selection(fields)
        )
        return await typed_out(
            [_exported_repo(node, fields) for node in nodes],
            fl,
            "",
            REPO_FIELDS,
        )
    rows = [
        _repo(value) for value in await list_repos(inv.config, owner, limit)
    ]
    human = "".join(
        f"{row.get('nameWithOwner', '')}\t"
        f"{row.get('description', '')}\t"
        f"{row.get('visibility', '')}\t"
        f"{row.get('updatedAt', '')}\n"
        for row in rows
    )
    return await typed_out(rows, fl, human, REPO_FIELDS)


async def create_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    spec = inv.texts[0] if inv.texts else ""
    if not spec:
        raise ValueError(
            "a repository name is required in noninteractive mode"
        )
    parts = spec.split("/")
    if len(parts) > 2 or any(not part for part in parts):
        raise ValueError(f'invalid repository name: "{spec}"')
    owner = parts[0] if len(parts) == 2 else None
    name = parts[-1]
    if gh_bool(fl, "public") and gh_bool(fl, "private"):
        raise ValueError("--public and --private are mutually exclusive")
    body: dict[str, JsonValue] = {
        "name": name,
        "private": gh_bool(fl, "private"),
        "auto_init": gh_bool(fl, "add_readme"),
    }
    for flag, key in (
        ("description", "description"),
        ("homepage", "homepage"),
    ):
        value = fl.as_str(flag)
        if value is not None:
            body[key] = value
    created = _repo(await create_repo(inv.config, owner, body))
    return text_out(f"{created.get('url', '')}\n")


async def fork(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    """``gh repo fork``.

    gh clones a fork, or adds a remote for one, into the local checkout,
    which a workspace does not have: ``--clone`` is refused, and so is
    ``--remote`` without a repository, where it would name that checkout.
    gh ignores ``--remote`` beside a repository, and ``--clone=false`` or
    ``--remote=false`` asks for what this fork does anyway.

    Args:
        inv (CLIInvocation[GhConfig]): the repository and the flags.
    """
    fl = FlagView(inv.flags)
    operand = inv.texts[0] if inv.texts else None
    org = fl.as_str("org")
    if org == "":
        raise ValueError("--org cannot be blank")
    if fl.as_str("remote_name") == "":
        raise ValueError("--remote-name cannot be blank")
    if gh_bool(fl, "clone"):
        raise ValueError(
            "--clone is not supported: there is no local checkout to clone "
            "into"
        )
    if gh_bool(fl, "remote") and operand is None:
        raise ValueError(
            "--remote is not supported: there is no local checkout to add a "
            "remote to"
        )
    source: RepoRef
    try:
        source = gh_repo(inv.config, operand)
    except ValueError as exc:
        if operand is None:
            raise
        raise ValueError(f"did not understand argument: {exc}") from exc
    name = fl.as_str("fork_name")
    body: dict[str, JsonValue] = {}
    if name is not None:
        body["name"] = name
    if org is not None:
        body["organization"] = org
    if gh_bool(fl, "default_branch_only"):
        body["default_branch_only"] = True
    forked = await fork_repo(inv.config, source, body)
    landed = forked.get("full_name") if isinstance(forked, dict) else None
    full = (
        landed
        if isinstance(landed, str)
        else (f"{await login(inv.config)}/{name or source.repo}")
    )
    return text_out(f"✓ Created fork {full}\n")


def token_header(config: GhConfig) -> dict[str, str]:
    """The Authorization git sends GitHub for the install's token: Basic
    with the token as the password, what gh's credential helper hands git.

    Args:
        config (GhConfig): the install's configuration.
    """
    secret = f"x-access-token:{config.token.get_secret_value()}"
    return {
        "Authorization": f"Basic {base64.b64encode(secret.encode()).decode()}"
    }


async def clone_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    """``gh repo clone``: mirage's ``git clone`` of the repository, the words
    after ``--`` as git's options. The token rides only as the request's
    Authorization, never on the line, in the config or in the output; a fork's
    ``upstream`` remote is not added.

    Args:
        inv (CLIInvocation[GhConfig]): the repository, the directory and
            git's options.
    """
    names, gitflags = split_marked(tuple(inv.texts), inv.argv)
    if not names:
        raise ValueError("cannot clone: repository argument required")
    spec = names[0]
    check_host(inv.config, repo_host(spec))
    if "/" not in spec and ":" not in spec:
        ref = RepoRef(owner=await login(inv.config), repo=spec)
    else:
        ref = parse_repo(spec)
    url = f"{web_origin(inv.config)}/{ref.owner}/{ref.repo}.git"
    target = names[1] if len(names) > 1 else ref.repo
    leaf, _ = find_node(GIT.spec, ["clone"]) or (GIT.spec, ())
    words = [*gitflags, url, target]
    parsed = parse_command(
        leaf,
        words,
        inv.cwd.virtual,
        "git clone",
        inv.env,
        unknown_is_operand=True,
    )
    flags: dict[str, FlagValue] = dict(parse_to_kwargs(parsed))
    flags["C"] = inv.cwd
    git = CLIInvocation[None](
        None,
        argv=("clone", *words),
        texts=tuple(word for word, _ in parsed.args),
        cwd=inv.cwd,
        flags=flags,
        stdin=inv.stdin,
        env=inv.env,
        view=inv.view,
        spec=leaf,
    )
    return await git_clone(git, token_header(inv.config))


async def rename(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    # gh takes the *new name* as the operand and the repository to rename as
    # -R, which is the reverse of what the shape of the line suggests.
    target = gh_repo(inv.config, fl.as_str("repo"))
    name = inv.texts[0] if inv.texts else ""
    if not name:
        raise ValueError("a new repository name is required")
    renamed = await rename_repo(inv.config, target, name)
    landed = renamed.get("full_name") if isinstance(renamed, dict) else None
    full = landed if isinstance(landed, str) else name
    return text_out(f"✓ Renamed repository {full}\n")


async def edit_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    """``gh repo edit``.

    The settings named on the line in one PATCH, and topics read and
    replaced whole when ``--add-topic`` or ``--remove-topic`` changes them.
    With nothing to edit gh would prompt, so it refuses instead, and a
    visibility change needs ``--accept-visibility-change-consequences``.
    Like gh writing to anything but a terminal, success prints nothing.

    Args:
        inv (CLIInvocation[GhConfig]): the invocation.
    """
    fl = FlagView(inv.flags, inv.spec)
    ref = gh_repo(inv.config, inv.texts[0] if inv.texts else None)
    body: dict[str, JsonValue] = {}
    security: dict[str, JsonValue] = {}
    for field in REPO_EDIT_FIELDS:
        dest = flag_kwarg_name(field.flag)
        if fl.raw(dest) is None:
            continue
        if field.kind == "value":
            body[field.field] = fl.as_str(dest)
        else:
            enabled = gh_bool(fl, dest)
            if field.kind == "security":
                security[field.field] = {
                    "status": "enabled" if enabled else "disabled"
                }
            else:
                body[field.field] = enabled
    adds = csv_values(fl.as_list("add_topic"))
    removes = csv_values(fl.as_list("remove_topic"))
    accepted = gh_bool(fl, "accept_visibility_change_consequences")
    if not (body or security or adds or removes or accepted):
        raise UsageError(
            "specify properties to edit when not running interactively", 1
        )
    if "visibility" in body and not accepted:
        raise UsageError(
            "use of --visibility flag requires "
            "--accept-visibility-change-consequences flag",
            1,
        )
    if security:
        node = await repository_fields(inv.config, ref, "viewerCanAdminister")
        if node.get("viewerCanAdminister") is not True:
            raise ValueError(
                "you do not have sufficient permissions to edit "
                "repository security and analysis features"
            )
        body["security_and_analysis"] = security
    if body:
        await edit_repo(inv.config, ref, body)
    if adds or removes:
        old = await repo_topics(inv.config, ref)
        wanted = list(dict.fromkeys([*old, *adds]))
        new = [topic for topic in wanted if topic not in removes]
        if len(new) != len(old) or any(topic not in old for topic in new):
            await set_repo_topics(inv.config, ref, new)
    return b"", IOResult()


async def delete_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    """``gh repo delete REPO --yes``.

    A name with no owner is the viewer's, as gh reads it. The current
    repository is never deleted by default: gh ignores ``--yes`` there and
    prompts, so without a terminal it refuses. ``--confirm`` is gh's
    deprecated spelling of ``--yes``, and it warns the way cobra does.

    Args:
        inv (CLIInvocation[GhConfig]): the invocation.
    """
    fl = FlagView(inv.flags)
    confirmed = gh_bool(fl, "yes") or gh_bool(fl, "confirm")
    spec = inv.texts[0] if inv.texts else None
    if spec is None and confirmed:
        raise UsageError(
            "cannot non-interactively delete current repository. Please "
            "specify a repository or run interactively",
            1,
        )
    if not confirmed:
        raise UsageError("--yes required when not running interactively", 1)
    named = spec or ""
    if "/" not in named:
        named = f"{await login(inv.config)}/{named}"
    await delete_repo(inv.config, gh_repo(inv.config, named))
    warning = (
        b"Flag --confirm has been deprecated, use `--yes` instead\n"
        if gh_bool(fl, "confirm")
        else b""
    )
    return b"", IOResult(stderr=warning)
