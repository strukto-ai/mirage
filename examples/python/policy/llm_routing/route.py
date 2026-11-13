TASK = (
    "Pick the machine that can run the Python code in this line, monty "
    "when it can."
)

MACHINES = {
    "monty": (
        "Mirage's sandboxed Python: a subset of the language and part of "
        "the standard library, with no packages, network or subprocesses"
    ),
    "local": (
        "the host's full Python: the whole language and standard library "
        "and any installed package, with the host's files and network"
    ),
}


async def pre_execute(ctx):
    if any(c["command"] == "python3" for c in ctx["commands"]):
        choice = await parse_machine(TASK, MACHINES, ctx["line"])
        return {"kind": "route", **choice}
