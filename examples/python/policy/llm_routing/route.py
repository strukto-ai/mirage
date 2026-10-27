import json
import os

TASK = (
    "Pick the runtime that can run the Python code in this line, monty "
    "when it can."
)

RUNTIMES = {
    "monty": (
        "Mirage's sandboxed Python: a subset of the language and part of "
        "the standard library, with no packages, network or subprocesses"
    ),
    "local": (
        "the host's full Python: the whole language and standard library "
        "and any installed package, with the host's files and network"
    ),
}

ctx = json.loads(os.environ["MIRAGE_POLICY_CTX"])
if any(c["command"] == "python3" for c in ctx["commands"]):
    choice = await parse_runtime(TASK, RUNTIMES, ctx["line"])
    print(json.dumps({"kind": "route", **choice}))
