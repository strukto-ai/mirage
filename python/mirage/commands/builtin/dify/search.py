from mirage.commands.builtin.generic.search import make_search, unit_threshold
from mirage.commands.errors import UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.core.dify.search import METHODS
from mirage.types import JsonValue


def _options(fl: FlagView) -> dict[str, JsonValue]:
    method = fl.as_str("method", "semantic")
    if method not in METHODS:
        raise UsageError(
            "search: method must be one of semantic, fulltext, hybrid, keyword"
        )
    top_k = fl.as_int("top_k")
    return {
        "top_k": top_k if top_k is not None else 10,
        "method": method,
        "threshold": unit_threshold(fl),
    }


search = make_search("dify", _options)
