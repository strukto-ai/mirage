from mirage.commands.builtin.generic.search import make_search
from mirage.commands.spec.flag_view import FlagView
from mirage.types import JsonValue


def _options(fl: FlagView) -> dict[str, JsonValue]:
    top_k = fl.as_int("top_k")
    return {
        "top_k": top_k if top_k is not None else 10,
        "method": fl.as_str("method") or "semantic",
        "threshold": fl.as_float("threshold") or 0.0,
    }


search = make_search("dify", _options)
