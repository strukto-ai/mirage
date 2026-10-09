from importlib.resources import files

STORE_LUA = (files("mirage.execution.redis") / "store.lua").read_text(
    encoding="utf-8"
)
POLL_SECONDS = 0.1
