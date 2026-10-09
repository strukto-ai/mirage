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

import asyncio
from dataclasses import replace

from mirage.commands.builtin.utils.stream import read_stdin_async
from mirage.commands.cli.builtin.git.dates import date_clock
from mirage.commands.cli.builtin.git.errors import (
    FormatUsageError,
    GitError,
)
from mirage.commands.cli.builtin.git.ref_filter import (
    filter_words,
    ref_filter,
    without_filter_values,
)
from mirage.commands.cli.builtin.git.ref_format import (
    format_refs,
    parse_format,
    used_fields,
)
from mirage.commands.cli.builtin.git.ref_list import (
    is_root_ref,
    listing_result,
    match_as_path,
    read_config,
    ref_listing,
    sort_keys,
)
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import QuoteStyle, RefKind
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    fatal,
)
from mirage.commands.cli.types import CLIInvocation, CLIView
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult

DEFAULT_FORMAT = "%(objectname) %(objecttype)\t%(refname)"
QUOTE_OPTIONS = (
    ("shell", QuoteStyle.SHELL),
    ("perl", QuoteStyle.PERL),
    ("python", QuoteStyle.PYTHON),
    ("tcl", QuoteStyle.TCL),
)


def quote_style(fl: FlagView) -> QuoteStyle:
    """The one quoting option a line chose, none for plain text.

    Args:
        fl (FlagView): spec-bound options.

    Raises:
        FormatUsageError: two of them.
    """
    chosen = {style for name, style in QUOTE_OPTIONS if fl.as_bool(name)}
    if len(chosen) > 1:
        raise FormatUsageError("more than one quoting style?")
    return chosen.pop() if chosen else QuoteStyle.NONE


async def for_each_ref(
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    """Format the repository's references, as git's ref-filter does.

    The refs are chosen by the path patterns, ``--exclude`` and the
    commit filters, ordered by the ``--sort`` keys (refname when none),
    and each is printed through ``--format``.

    Args:
        inv (CLIInvocation[None]): optional ref patterns and options.
    """
    fl = FlagView(inv.flags)
    view = inv.view or CLIView()
    words = filter_words(inv)
    texts = without_filter_values(inv.texts, words)
    try:
        check_switches(inv, texts)
        repo, location = await opened(fl, view)
        assert view.dispatch is not None
        filt = await asyncio.to_thread(ref_filter, repo, words)
        count = fl.as_int("count") or 0
        if count < 0:
            raise FormatUsageError(f"invalid --count argument: `{count}'")
        template = fl.as_str("format")
        fmt = parse_format(
            DEFAULT_FORMAT if template is None else template, quote_style(fl)
        )
        keys = sort_keys(fl, ("refname",))
        icase = fl.as_bool("ignore_case")
        patterns = texts
        if fl.as_bool("stdin"):
            if texts:
                raise GitError("unknown arguments supplied with --stdin")
            text = (await read_stdin_async(inv.stdin) or b"").decode(
                "utf-8", "replace"
            )
            lines = text.split("\n")
            if lines[-1] == "":
                lines.pop()
            patterns = tuple(line.removesuffix("\r") for line in lines)
        roots = fl.as_bool("include_root_refs")
        excludes = tuple(fl.as_list("exclude"))

        def wanted(name: str) -> bool:
            listed = name.startswith("refs/") or (roots and is_root_ref(name))
            return (
                listed
                and match_as_path(name, patterns, icase)
                and not (excludes and match_as_path(name, excludes, icase))
            )

        items, ctx, errors = await ref_listing(
            view.dispatch,
            repo,
            location,
            await read_config(view.dispatch, location),
            used_fields(fmt, keys or ()),
            wanted,
            filt,
            date_clock(inv.env),
            roots,
        )
        if roots:
            items = [
                replace(item, kind=RefKind.ROOT)
                if item.kind is RefKind.DETACHED
                else item
                for item in items
            ]
        out, stopped = format_refs(
            fmt,
            items,
            ctx,
            keys,
            count=count,
            omit_empty=fl.as_bool("omit_empty"),
            icase=icase,
            stream=filt is None
            or (filt.merged is None and filt.no_merged is None),
        )
    except GitError as exc:
        return fatal(exc)
    return listing_result(out, errors, stopped)
