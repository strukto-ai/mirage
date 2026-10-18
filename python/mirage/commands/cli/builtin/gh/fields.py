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

# The --json selections and exports follow gh 2.85.0, printed as Go
# 1.25.5's encoding/json prints them (MIT and BSD-3-Clause; see
# licenses/third_party/gh.txt and go.txt).

from collections.abc import Awaitable, Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from mirage.commands.cli.builtin.gh.shape import (
    ListOf,
    Shape,
    exported,
    pointer,
    struct,
)

Node = dict[str, Any]

# Reads a selection of the issue or pull request a line names, with
# $endCursor bound to the cursor when the selection reads a later page.
Fetch = Callable[[str, str | None], Awaitable[Node]]


@dataclass(frozen=True, slots=True)
class Pages:
    """A connection ``gh pr view`` and ``gh issue view`` read to its end.

    Args:
        select (Callable[[str], str]): its selection given the clause that
            picks the page after ``$endCursor``, or no clause, for a field
            read apart.
        at (Callable[[Node], Node]): where the connection sits in an
            answer.
    """

    select: Callable[[str], str]
    at: Callable[[Node], Node]


@dataclass(frozen=True, slots=True)
class Field:
    """One ``--json`` field of an issue or a pull request: the GraphQL
    selection gh 2.85 puts on the wire for it (read off its query builder,
    and captured with ``GH_DEBUG=api``), and gh's own export of the answer
    (``ExportData``).

    Args:
        select (str): the selection inside the issue or pull request.
        export (Callable[[Node], Any]): gh's export of the answer.
        view (str | None): how ``gh pr view`` or ``gh issue view`` reads a
            field it leaves out of its main query: ``never`` for one it
            never asks github.com for, ``apart`` for one it reads in a
            query of its own. The list commands ask for both inline.
        pages (Pages | None): set for a connection the view commands read
            to its end.
    """

    select: str
    export: Callable[[Node], Any]
    view: Literal["never", "apart"] | None = None
    pages: Pages | None = None


def record(value: Any) -> Node:
    return value if isinstance(value, dict) else {}


def nodes_of(value: Any) -> list[Any]:
    nodes = record(value).get("nodes")
    return nodes if isinstance(nodes, list) else []


# gh's CommentAuthor: a comment's or a review's author prints its login
# alone.
LOGIN = struct(("login", "string"))
_USER = struct(
    ("id", "string"),
    ("login", "string"),
    ("name", "string"),
    ("databaseId", "int"),
)
_LABEL = struct(
    ("id", "string"),
    ("name", "string"),
    ("description", "string"),
    ("color", "string"),
)
# Its url is omitempty, and gh always asks for it, so it always prints.
_COMMENT = struct(
    ("id", "string"),
    ("author", LOGIN),
    ("authorAssociation", "string"),
    ("body", "string"),
    ("createdAt", "time"),
    ("includesCreatedEdit", "bool"),
    ("isMinimized", "bool"),
    ("minimizedReason", "string"),
    ("reactionGroups", "reactions"),
    ("url", "string"),
    ("viewerDidAuthor", "bool"),
)
# The maps gh builds by hand print their keys sorted, as Go's encoder
# does.
_REFERENCE = struct(
    ("id", "string"),
    ("number", "int"),
    (
        "repository",
        struct(
            ("id", "string"),
            ("name", "string"),
            ("owner", struct(("id", "string"), ("login", "string"))),
        ),
    ),
    ("url", "string"),
)
_STATUS = struct(("optionId", "string"), ("name", "string"))
_PROJECT_CARD = struct(
    ("project", struct(("name", "string"))),
    ("column", struct(("name", "string"))),
)

AFTER = ", after: $endCursor"


def _comments(after: str) -> str:
    return (
        f"comments(first: 100{after}) {{nodes {{id,author{{login,"
        "...on User{id,name}},authorAssociation,body,createdAt,"
        "includesCreatedEdit,isMinimized,minimizedReason,"
        "reactionGroups{content,users{totalCount}},url,viewerDidAuthor},"
        "pageInfo{hasNextPage,endCursor},totalCount}"
    )


def _project_items_alone(after: str) -> str:
    return (
        f"projectItems(first: 100{after}){{totalCount,nodes{{id,"
        'project{id,title},status:fieldValueByName(name: "Status")'
        "{... on ProjectV2ItemFieldSingleSelectValue{optionId,name}}},"
        "pageInfo{hasNextPage,endCursor}}"
    )


_PROJECT_ITEMS = (
    "projectItems(first:100){nodes{id, project{id,title}, "
    'status:fieldValueByName(name: "Status") { ... on '
    "ProjectV2ItemFieldSingleSelectValue{optionId,name}}},"
    "totalCount}"
)

# The refusals gh reads as "this token or host has no Projects", which
# leave project items empty rather than failing a view.
_PROJECTS_V2_IGNORABLE = (
    "field requires one of the following scopes: ['read:project']",
    "Field 'projectsV2' doesn't exist on type 'User'",
    "Field 'projectsV2' doesn't exist on type 'Repository'",
    "Field 'projectsV2' doesn't exist on type 'Organization'",
    "Field 'projectItems' doesn't exist on type 'Issue'",
    "Field 'projectItems' doesn't exist on type 'PullRequest'",
)


def _project_items_of(node: Node) -> list[Any]:
    return [
        {
            "status": exported(record(item).get("status"), _STATUS),
            "title": exported(
                record(record(item).get("project")).get("title"), "string"
            ),
        }
        for item in nodes_of(node.get("projectItems"))
    ]


def plain(
    name: str, shape: Shape, select: str | None = None
) -> tuple[str, Field]:
    return name, Field(
        select or name, lambda node: exported(node.get(name), shape)
    )


def nodes(
    name: str, select: str, item: Shape, pages: Pages | None = None
) -> tuple[str, Field]:
    return name, Field(
        select,
        lambda node: exported(
            record(node.get(name)).get("nodes"), ListOf(item)
        ),
        pages=pages,
    )


def paged(name: str, select: Callable[[str], str]) -> Pages:
    return Pages(select, lambda node: record(node.get(name)))


def references(name: str) -> tuple[str, Field]:
    """A list of references to issues or pull requests in some
    repository, the shape gh gives both ``closingIssuesReferences`` and
    ``closedByPullRequestsReferences``: always a list, read to its end.

    Args:
        name (str): the field.
    """

    def select(after: str) -> str:
        return (
            f"{name}(first: 100{after}) {{nodes {{id,number,url,"
            "repository {id,name,owner {id,login}}}"
            "pageInfo{hasNextPage,endCursor}}"
        )

    return name, Field(
        select(""),
        lambda node: [
            exported(item, _REFERENCE) for item in nodes_of(node.get(name))
        ],
        pages=paged(name, select),
    )


# The fields issues and pull requests share, as gh 2.85's
# sharedIssuePRFields names them. projectItems is read apart by both
# views; projectCards is asked for as it stands, and each command says
# whether its view does.
SHARED_FIELDS: tuple[tuple[str, Field], ...] = (
    nodes(
        "assignees",
        "assignees(first:100){nodes{id,login,name},totalCount}",
        _USER,
    ),
    plain("author", "author", "author{login,...on User{id,name}}"),
    plain("body", "string"),
    plain("closed", "bool"),
    plain("closedAt", "raw"),
    nodes("comments", _comments(""), _COMMENT, paged("comments", _comments)),
    plain("createdAt", "time"),
    plain("id", "string"),
    nodes(
        "labels",
        "labels(first:100){nodes{id,name,description,color},totalCount}",
        _LABEL,
    ),
    plain(
        "milestone",
        pointer(
            ("number", "int"),
            ("title", "string"),
            ("description", "string"),
            ("dueOn", "raw"),
        ),
        "milestone{number,title,description,dueOn}",
    ),
    plain("number", "int"),
    nodes(
        "projectCards",
        "projectCards(first:100){nodes{project{name}column{name}},totalCount}",
        _PROJECT_CARD,
    ),
    (
        "projectItems",
        Field(
            _PROJECT_ITEMS,
            _project_items_of,
            view="apart",
            pages=paged("projectItems", _project_items_alone),
        ),
    ),
    plain(
        "reactionGroups",
        "reactions",
        "reactionGroups{content,users{totalCount}}",
    ),
    plain("state", "string"),
    plain("title", "string"),
    plain("updatedAt", "time"),
    plain("url", "string"),
)


def selection(
    table: Mapping[str, Field], names: Iterable[str], for_view: bool
) -> str:
    """The GraphQL selection for the fields named, in their order, each
    once. A view leaves out the fields it reads some other way.

    Args:
        table (Mapping[str, Field]): the command's fields.
        names (Iterable[str]): the fields to ask for.
        for_view (bool): whether the selection serves a view.
    """
    specs = [table[name] for name in dict.fromkeys(names)]
    return ",".join(
        spec.select
        for spec in specs
        if not (for_view and spec.view is not None)
    )


def exported_node(
    table: Mapping[str, Field], node: Node, fields: list[str]
) -> Node:
    """One answer as gh exports the fields asked for.

    Args:
        table (Mapping[str, Field]): the command's fields.
        node (Node): the GraphQL answer.
        fields (list[str]): the ``--json`` fields.
    """
    return {field: table[field].export(node) for field in fields}


async def _read_to_end(fetch: Fetch, node: Node, pages: Pages) -> None:
    """Read the rest of one connection into the answer that holds its
    first page.

    Args:
        fetch (Fetch): reads a selection of the issue or pull request.
        node (Node): the answer holding the first page.
        pages (Pages): the connection.
    """
    first = pages.at(node)
    rows = list(nodes_of(first))
    info = record(first.get("pageInfo"))
    while info.get("hasNextPage") and isinstance(info.get("endCursor"), str):
        cursor = info["endCursor"]
        page = pages.at(await fetch(pages.select(AFTER), cursor))
        rows.extend(nodes_of(page))
        info = record(page.get("pageInfo"))
        if info.get("endCursor") == cursor:
            raise ValueError("GitHub returned a non-advancing cursor")
    first["nodes"] = rows


async def _project_items_apart(fetch: Fetch, pages: Pages) -> Node:
    """Project items, read the way gh reads them: apart, and none
    without the scope.

    Args:
        fetch (Fetch): reads a selection of the issue or pull request.
        pages (Pages): the project item connection.
    """
    try:
        node = await fetch(pages.select(""), None)
        await _read_to_end(fetch, node, pages)
    except ValueError as exc:
        if any(refusal in str(exc) for refusal in _PROJECTS_V2_IGNORABLE):
            return {"nodes": []}
        raise
    return pages.at(node)


async def read_rest(
    table: Mapping[str, Field], node: Node, fields: list[str], fetch: Fetch
) -> Node:
    """Finish reading a view's answer: every connection gh follows read to
    its end, and the fields it reads apart read that way, through
    ``fetch``.

    Args:
        table (Mapping[str, Field]): the command's fields.
        node (Node): the view's main answer.
        fields (list[str]): the ``--json`` fields.
        fetch (Fetch): reads a selection of the issue or pull request.
    """
    for field in dict.fromkeys(fields):
        spec = table[field]
        if spec.pages is None:
            continue
        if spec.view == "apart":
            node[field] = await _project_items_apart(fetch, spec.pages)
        else:
            await _read_to_end(fetch, node, spec.pages)
    return node
