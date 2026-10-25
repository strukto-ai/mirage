from mirage.commands.builtin.generic.search import (
    make_search,
    semantic_options,
)
from mirage.commands.spec.flag_view import FlagView
from mirage.types import JsonValue


def _options(fl: FlagView) -> dict[str, JsonValue]:
    return {"top_k": 10, **semantic_options(fl)}


search = make_search("chroma", _options, name="chroma-query")
