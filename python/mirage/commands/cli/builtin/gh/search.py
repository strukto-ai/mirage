import json
import re
from functools import partial
from typing import Any

from mirage.commands.cli.builtin.gh.accessor import (
    csv_values,
    gh_bool,
    json_fields,
    text_out,
    typed_out,
)
from mirage.commands.cli.builtin.gh.constants import (
    SEARCH_ALIASES,
    SEARCH_BOOLEAN,
    SEARCH_FIELDS,
    SEARCH_FLAGS,
    SEARCH_MULTIPLE,
    SEARCH_SHAPES,
    SEARCH_SORTS,
)
from mirage.commands.cli.builtin.gh.template import render_template
from mirage.commands.cli.types import CLIHandler, CLIInvocation
from mirage.commands.errors import UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.core.github.client import GitHubApiError
from mirage.core.github.config import GhConfig
from mirage.core.github.search import search
from mirage.io.types import CommandOutput, IOResult


def _quote(value: str) -> str:
    return (
        json.dumps(value, ensure_ascii=False)
        if re.search(r'[\s"]', value)
        else value
    )


def _boolean(fl: FlagView, name: str) -> bool:
    return gh_bool(fl, name.replace("-", "_"))


def _query(kind: str, words: tuple[str, ...], fl: FlagView) -> str:
    qualifiers: dict[str, list[str]] = {}
    for name in SEARCH_FLAGS[kind]:
        value = fl.raw(name.replace("-", "_"))
        if (
            value is None
            or name in ("app", "include-prs", "locked", "merged")
            or name.startswith("no-")
        ):
            continue
        key = SEARCH_ALIASES.get(name, name)
        if (
            name == "review-requested"
            and isinstance(value, str)
            and "/" in value
        ):
            key = "team-review-requested"
        if name in SEARCH_BOOLEAN:
            values = [str(_boolean(fl, name)).lower()]
        elif name in SEARCH_MULTIPLE:
            values = csv_values(fl.as_list(name.replace("-", "_")))
        else:
            values = [fl.as_str(name.replace("-", "_")) or ""]
        qualifiers.setdefault(key, []).extend(v for v in values if v)
    if kind in ("issues", "prs"):
        if kind == "prs" or not _boolean(fl, "include_prs"):
            qualifiers["type"] = ["pr" if kind == "prs" else "issue"]
        if fl.as_str("app") is not None:
            if fl.as_str("author") is not None:
                raise UsageError("specify only `--author` or `--app`", 1)
            qualifiers["author"] = ["app/" + (fl.as_str("app") or "")]
        for name in ("locked", "merged") if kind == "prs" else ("locked",):
            if fl.raw(name) is not None:
                qualifiers.setdefault("is", []).append(
                    name if _boolean(fl, name) else "un" + name
                )
        qualifiers["no"] = [
            name
            for name in ("assignee", "label", "milestone", "project")
            if _boolean(fl, "no_" + name)
        ]
    keywords = []
    for word in words:
        head, colon, tail = word.partition(":")
        keywords.append(head + ":" + _quote(tail) if colon else _quote(word))
    return " ".join(
        keywords
        + sorted(
            f"{key}:{_quote(v)}"
            for key, values in qualifiers.items()
            for v in values
        )
    )


def _option(name: str) -> Argument:
    choices = {
        "state": ("open", "closed"),
        "include-forks": ("false", "true", "only"),
        "checks": ("pending", "success", "failure"),
        "review": ("none", "required", "approved", "changes_requested"),
    }.get(name, ())
    short = {"repo": "-R", "base": "-B", "head": "-H"}.get(name)
    names = (short, "--" + name) if short is not None else ("--" + name,)
    return Argument(
        *names,
        action="append" if name in SEARCH_MULTIPLE else "store",
        nargs="?" if name in SEARCH_BOOLEAN else None,
        attached_only=name in SEARCH_BOOLEAN,
        choices=("true", "false") if name in SEARCH_BOOLEAN else choices,
    )


def search_spec() -> CommandSpec:
    leaves = []
    for kind in SEARCH_FLAGS:
        options = [_option(name) for name in SEARCH_FLAGS[kind]]
        options.extend(
            (
                Argument("--json"),
                Argument("-q", "--jq"),
                Argument("-t", "--template"),
                Argument("-L", "--limit", type="int", default="30"),
            )
        )
        if kind in SEARCH_SORTS:
            options.extend(
                (
                    Argument("--sort", choices=tuple(SEARCH_SORTS[kind])),
                    Argument("--order", choices=("asc", "desc")),
                )
            )
        leaves.append(
            CommandSpec(
                name=kind,
                description=f"Search for {kind}",
                arguments=(*options, Argument("QUERY", nargs="*")),
            )
        )
    return CommandSpec(
        name="search", description="Search GitHub", subcommands=tuple(leaves)
    )


def search_handlers() -> dict[str, CLIHandler]:
    """Bind the search leaves by their canonical paths below gh."""
    return {
        f"search {kind}": CLIHandler(fn=partial(search_cmd, kind))
        for kind in SEARCH_FLAGS
    }


def _search_error(exc: GitHubApiError, query: str) -> str:
    """How gh search words a failed search, its ``httpError.Error``.

    A 422 naming its errors says the query is invalid, with the first
    reason; anything else is the status, GitHub's message (the status
    line for a body that is not JSON) and the request URL.

    Args:
        exc (GitHubApiError): the failure.
        query (str): the ``q`` the search sent.
    """
    data = exc.data if isinstance(exc.data, dict) else None
    errors = data.get("errors") if data is not None else None
    if exc.status == 422 and isinstance(errors, list) and errors:
        first = errors[0] if isinstance(errors[0], dict) else {}
        reason = first.get("message")
        quoted = json.dumps(query.strip(), ensure_ascii=False)
        return (
            f"Invalid search query {quoted}.\n"
            f"{reason if isinstance(reason, str) else ''}"
        )
    if data is None:
        message = f"{exc.status} {exc}"
    else:
        found = data.get("message")
        message = found if isinstance(found, str) else ""
    return f"HTTP {exc.status}: {message} ({exc.url})"


async def search_cmd(kind: str, inv: CLIInvocation[GhConfig]) -> CommandOutput:
    fl = FlagView(inv.flags, inv.spec)
    fields = json_fields(fl, SEARCH_FIELDS[kind])
    limit = fl.as_int("limit")
    if limit is None or limit < 1 or limit > 1000:
        raise UsageError("`--limit` must be between 1 and 1000", 1)
    if not inv.texts and len(inv.argv) <= 2:
        raise UsageError("specify search keywords or flags", 1)
    if fields is None and (
        fl.as_str("jq") is not None or fl.as_str("template") is not None
    ):
        raise UsageError(
            "cannot use `--jq` or `--template` without `--json`", 1
        )
    if fl.as_str("jq") is not None and fl.as_str("template") is not None:
        raise UsageError("cannot use `--jq` and `--template` together", 1)
    query = _query(kind, inv.texts, fl)
    try:
        values = await search(
            inv.config,
            {"repos": "repositories", "prs": "issues"}.get(kind, kind),
            query,
            limit,
            fl.as_str("sort") if kind in SEARCH_SORTS else None,
            fl.as_str("order") if kind in SEARCH_SORTS else None,
        )
    except GitHubApiError as exc:
        return None, IOResult(
            exit_code=1, stderr=f"{_search_error(exc, query)}\n".encode()
        )
    rows = [_export(kind, value) for value in values]
    template = fl.as_str("template")
    if template is not None:
        selected = [
            {key: row.get(key) for key in sorted(fields or [])} for row in rows
        ]
        return text_out(render_template(template, selected))
    return await typed_out(
        rows,
        fl,
        _human(
            kind,
            rows,
            values,
            kind == "issues" and _boolean(fl, "include_prs"),
        ),
        SEARCH_FIELDS[kind],
    )


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _shape(kind: str, value: Any) -> Any:
    if kind.startswith("*"):
        return None if value is None else _shape(kind[1:], value)
    if kind.startswith("[]"):
        return (
            [_shape(kind[2:], item) for item in value]
            if isinstance(value, list)
            else None
        )
    if kind == "time.Time":
        return value or "0001-01-01T00:00:00Z"
    if kind == "string":
        return value or ""
    if kind == "bool":
        return bool(value)
    if kind == "int":
        return value or 0
    row = _record(value)
    return {
        name: _shape(typ, row.get(key))
        for name, key, typ in SEARCH_SHAPES.get(kind, [])
    }


def _user(value: Any) -> dict[str, Any]:
    row = _record(value)
    bot = not row.get("node_id")
    return {
        "id": row.get("node_id") or "",
        "login": ("app/" if bot else "") + (row.get("login") or ""),
        "type": row.get("type") or "",
        "url": row.get("html_url") or "",
        "is_bot": bot,
    }


def _export(kind: str, value: Any) -> dict[str, Any]:
    raw = _record(value)
    row: dict[str, Any] = _shape(
        {
            "repos": "Repository",
            "issues": "Issue",
            "prs": "Issue",
            "code": "Code",
            "commits": "Commit",
        }[kind],
        raw,
    )
    if kind == "repos":
        row["owner"] = _user(raw.get("owner"))
    elif kind in ("issues", "prs"):
        row["author"] = _user(raw.get("user"))
        row["assignees"] = [
            _user(user) for user in raw.get("assignees", []) or []
        ]
        row["labels"] = row.get("labels") or []
        pull = _record(raw.get("pull_request"))
        row["isPullRequest"] = bool(pull.get("html_url"))
        row["state"] = (
            "merged" if pull.get("merged_at") else raw.get("state", "")
        )
        parts = str(raw.get("repository_url", "")).rstrip("/").split("/")
        row["repository"] = {
            "name": parts[-1],
            "nameWithOwner": "/".join(parts[-2:]),
        }
    elif kind == "code":
        repo = _record(raw.get("repository"))
        row["repository"] = {
            "id": repo.get("node_id") or "",
            "nameWithOwner": repo.get("full_name") or "",
            "url": repo.get("html_url") or "",
            "isPrivate": bool(repo.get("private")),
            "isFork": bool(repo.get("fork")),
        }
        row["textMatches"] = [
            {
                "fragment": m.get("fragment", ""),
                "matches": m.get("matches"),
                "type": m.get("object_type", ""),
                "property": m.get("property", ""),
            }
            for m in raw.get("text_matches", []) or []
        ]
    elif kind == "commits":
        row["author"] = _user(raw.get("author"))
        row["committer"] = _user(raw.get("committer"))
        info = _record(raw.get("commit"))
        row["commit"] = {
            "author": _shape("CommitUser", info.get("author")),
            "committer": _shape("CommitUser", info.get("committer")),
            "comment_count": info.get("comment_count") or 0,
            "message": info.get("message") or "",
            "tree": _shape("Tree", info.get("tree")),
        }
        row["parents"] = row.get("parents") or []
        repo = _export("repos", raw.get("repository"))
        row["repository"] = {
            key: repo[key]
            for key in (
                "description",
                "fullName",
                "name",
                "id",
                "isFork",
                "isPrivate",
                "owner",
                "url",
            )
        }
    return row


def _human(
    kind: str, rows: list[dict[str, Any]], values: list[Any], both: bool
) -> str:
    lines = []
    for row, value in zip(rows, values):
        raw = _record(value)
        if kind in ("issues", "prs"):
            cells = (
                ["pr" if row["isPullRequest"] else "issue"] if both else []
            ) + [
                row["repository"]["nameWithOwner"],
                str(row["number"]),
                row["state"],
                " ".join(row["title"].split()),
                ", ".join(label["name"] for label in row["labels"]),
                row["updatedAt"],
            ]
        elif kind == "repos":
            tags = [
                row["visibility"]
                or ("private" if row["isPrivate"] else "public")
            ]
            tags += [
                label
                for key, label in (
                    ("isFork", "fork"),
                    ("isArchived", "archived"),
                )
                if row[key]
            ]
            cells = [
                row["fullName"],
                " ".join(row["description"].split()),
                ", ".join(tags),
                row["updatedAt"],
            ]
        elif kind == "commits":
            cells = [
                row["repository"]["fullName"],
                row["sha"],
                " ".join(row["commit"]["message"].split()),
                _record(raw.get("author")).get("login", ""),
                row["commit"]["author"]["date"],
            ]
        else:
            for match in row["textMatches"]:
                offset = 0
                for line in match["fragment"].split("\n"):
                    end = offset + len(line.encode())
                    if any(
                        offset <= m.get("indices", [-1])[0] < end
                        for m in match["matches"] or []
                    ):
                        lines.append(
                            f"{row['repository']['nameWithOwner']}:"
                            f"{row['path']}: {line.strip()}\n"
                        )
                    offset = end + 1
            continue
        lines.append("\t".join(cells) + "\n")
    return "".join(lines)
