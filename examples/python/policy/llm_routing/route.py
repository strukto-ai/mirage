import json
import os

RUNTIMES = {
    "monty": (
        "Mirage's sandboxed Python: a subset of the language and part of "
        "the standard library, with no packages, network or processes"
    ),
    "local": (
        "the host's full Python: the whole language and standard library "
        "and any installed package, with the host's files and network"
    ),
}

PROMPT = (
    "Pick the runtime that can run this shell line, monty when it can, "
    "and say why in one sentence.\n"
    + "\n".join(f"{name}: {about}" for name, about in RUNTIMES.items())
)

ctx = json.loads(os.environ["MIRAGE_POLICY_CTX"])
if any(c["command"] == "python3" for c in ctx["commands"]):
    choice = await parse_runtime(os.environ["MODEL"], PROMPT, ctx["line"])
    print(json.dumps({"kind": "route", **choice}))
