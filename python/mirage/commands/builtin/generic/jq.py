import dataclasses
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from typing import Any

import orjson

from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.core.jq import (DEFAULT_INDENT, JqOptions, args_object,
                            eval_jsonl_stream, format_jq_output, is_jsonl_path,
                            is_streamable_jsonl_expr, jq_eval, parse_json_docs,
                            parse_seq_docs, references_args, references_inputs,
                            split_raw_lines, stream_events)
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue, PathSpec

INDENT_MIN = -1
INDENT_MAX = 7

USAGE_HINT = ("Use jq --help for help with command-line options,\n"
              "or see the jq manpage, or online docs  at "
              "https://jqlang.github.io/jq")


def _pair_args(values: Sequence[Any]) -> list[tuple[str, Any]]:
    """Read a pair option's flattened values back as (name, value).

    Args:
        values (Sequence[Any]): the accumulated tokens, name then value.
            A "path" pair (--rawfile, --slurpfile) carries a PathSpec in
            every value slot.
    """
    return [(str(values[i]), values[i + 1])
            for i in range(0,
                           len(values) - 1, 2)]


def _pair_flag(fl: FlagView, name: str) -> list[tuple[str, Any]]:
    """Pairs recorded for one pair option, whatever their value type.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        name (str): the option's kwarg name.
    """
    raw = fl.raw(name)
    return _pair_args(raw) if isinstance(raw, list) else []


def positional_args(fl: FlagView, texts: Sequence[str],
                    has_program_file: bool) -> tuple[Any, ...]:
    """Values `$ARGS.positional` reports, from --args / --jsonargs.

    The operands after the program stop being input files once either
    flag appears, so they arrive here as ordinary text.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        texts (Sequence[str]): text operands, program included unless it
            came from a file.
        has_program_file (bool): whether -f supplied the program, which
            frees the first text slot.

    Raises:
        UsageError: when a --jsonargs value is not JSON.
    """
    as_json = fl.as_bool("jsonargs")
    if not as_json and not fl.as_bool("args"):
        return ()
    rest = list(texts) if has_program_file else list(texts[1:])
    if not as_json:
        return tuple(rest)
    values: list[Any] = []
    for value in rest:
        try:
            values.append(orjson.loads(value))
        except orjson.JSONDecodeError as exc:
            raise UsageError(
                f"jq: invalid JSON text passed to --jsonargs\n{USAGE_HINT}",
                2) from exc
    return tuple(values)


def named_args(fl: FlagView) -> dict[str, Any]:
    """Collect the $name bindings from --arg and --argjson.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.

    Raises:
        UsageError: when an --argjson value is not JSON.
    """
    args: dict[str, Any] = {}
    for name, value in _pair_args(fl.as_list("arg")):
        args[name] = value
    for name, value in _pair_args(fl.as_list("argjson")):
        try:
            args[name] = orjson.loads(value)
        except orjson.JSONDecodeError as exc:
            raise UsageError(
                f"jq: invalid JSON text passed to --argjson\n{USAGE_HINT}",
                2) from exc
    return args


async def file_args(
    fl: FlagView,
    read_bytes: Callable[..., Awaitable[bytes]],
) -> dict[str, Any]:
    """Collect the $name bindings that read a file.

    --rawfile binds the file's text, --slurpfile the array of documents
    in it, which is the same difference -R draws on the input stream.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        read_bytes (Callable): backend byte reader for one path.
    """
    args: dict[str, Any] = {}
    for name, path in _pair_flag(fl, "rawfile"):
        args[name] = (await read_bytes(path)).decode("utf-8", errors="replace")
    for name, path in _pair_flag(fl, "slurpfile"):
        args[name] = parse_json_docs(await read_bytes(path))
    return args


def parse_flags(fl: FlagView) -> JqOptions:
    """Read the raw jq flag kwargs into a frozen struct.

    Two deliberate divergences from jq's own parser, both from mirage
    parsing a whole line before acting on it rather than one option at a
    time. jq lets ``-c``, ``--tab`` and ``--indent`` override each other
    in the order typed; here ``-c`` wins whenever it appears. And jq
    reads a non-numeric ``--indent`` as 0 (C atoi), where mirage refuses
    it like every other int-typed option.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.

    Raises:
        UsageError: when --indent is out of range.
    """
    width = fl.as_int("indent")
    if width is not None and not INDENT_MIN <= width <= INDENT_MAX:
        raise UsageError(
            f"jq: --indent takes a number between {INDENT_MIN} and "
            f"{INDENT_MAX}\n{USAGE_HINT}", 2)
    # jq spells tab indentation both ways: --tab, or --indent -1.
    tab = fl.as_bool("tab") or width == INDENT_MIN
    indent = DEFAULT_INDENT if width is None or width == INDENT_MIN else width
    join_output = fl.as_bool("join_output")
    nul_output = fl.as_bool("raw_output0")
    return JqOptions(
        null_input=fl.as_bool("null_input"),
        raw_input=fl.as_bool("raw_input"),
        slurp=fl.as_bool("slurp"),
        stream=fl.as_bool("stream"),
        seq=fl.as_bool("seq"),
        # -j and --raw-output0 are -r plus a different separator.
        raw_output=fl.as_bool("raw_output") or join_output or nul_output,
        join_output=join_output,
        nul_output=nul_output,
        compact=fl.as_bool("compact_output"),
        ascii_output=fl.as_bool("ascii_output"),
        sort_keys=fl.as_bool("sort_keys"),
        tab=tab,
        indent=indent,
        exit_status=fl.as_bool("exit_status"),
        named_args=named_args(fl),
    )


def assemble_inputs(chunks: list[bytes], opts: JqOptions) -> list[JsonValue]:
    """Turn the raw inputs into the value stream the program sees.

    jq reads every file and stdin as one stream, so slurping spans them
    all rather than restarting per file. Line splitting stays per input:
    a file with no trailing newline ends its last line there instead of
    joining it to the next file's first.

    Args:
        chunks (list[bytes]): each input's bytes, in order.
        opts (JqOptions): resolved options.
    """
    if opts.raw_input:
        if opts.slurp:
            return [b"".join(chunks).decode("utf-8", errors="replace")]
        return [line for chunk in chunks for line in split_raw_lines(chunk)]
    parse = parse_seq_docs if opts.seq else parse_json_docs
    docs: list[JsonValue] = [doc for chunk in chunks for doc in parse(chunk)]
    if opts.stream:
        # --stream replaces each document with its events, and slurping
        # then collects the events rather than the documents.
        docs = [event for doc in docs for event in stream_events(doc)]
    return [docs] if opts.slurp else docs


def exit_code(outputs: Sequence[JsonValue], opts: JqOptions) -> int:
    """Exit status for a run, which only -e makes interesting.

    Args:
        outputs (Sequence[JsonValue]): every value the run printed.
        opts (JqOptions): resolved options.
    """
    if not opts.exit_status:
        return 0
    if not outputs:
        return 4
    last = outputs[-1]
    return 1 if last is None or last is False else 0


async def _read_stdin_bytes(stdin: ByteSource | None) -> bytes:
    if isinstance(stdin, bytes):
        return stdin
    if stdin is None:
        return b""
    raw = b""
    async for chunk in stdin:
        raw += chunk
    return raw


async def jq_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
) -> tuple[ByteSource | None, IOResult]:
    """Full-command jq entry; mirrors jqGeneric's (paths, texts, opts).

    The kwargs core below keeps the historical shape; this entry is the
    dispatcher-facing seam so the builder stays wiring.
    """
    return await jq(paths,
                    *texts,
                    read_bytes=read_bytes,
                    read_stream=read_stream,
                    stdin=opts.stdin,
                    **opts.flags)


async def jq(
    paths: list[PathSpec],
    *texts: str,
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    **flags: FlagValue,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["jq"])
    opts = parse_flags(fl)
    program_file = fl.raw("from_file")
    if isinstance(program_file, PathSpec):
        expression = (await read_bytes(program_file)).decode()
    else:
        # jq defaults the filter to "." when no expression is given.
        expression = texts[0] if texts else "."
    expr = expression.strip()
    wants_inputs = references_inputs(expr)
    # --rawfile / --slurpfile read a file each, so they join the bindings
    # only once the backend reader is in hand.
    opts = dataclasses.replace(
        opts,
        named_args={
            **opts.named_args,
            **await file_args(fl, read_bytes)
        },
        positional_args=positional_args(fl, texts,
                                        isinstance(program_file, PathSpec)),
    )
    args_value = args_object(opts) if references_args(expr) else None

    # The per-line path rewrites the program to run on one element, so it
    # can only serve a run whose input stream is the file's documents and
    # whose exit code does not depend on the last of them.
    streamable = (paths and is_jsonl_path(paths[0].virtual)
                  and is_streamable_jsonl_expr(expr) and not opts.null_input
                  and not opts.raw_input and not opts.slurp and not opts.stream
                  and not opts.seq and not opts.exit_status
                  and not wants_inputs)
    if streamable:
        return eval_jsonl_stream(read_stream(paths[0]), expr, opts), IOResult()

    chunks: list[bytes] = []
    # -n does not read its inputs at all unless the program asks for them
    # through `inputs`, which is why jq -n never opens a missing file.
    if not opts.null_input or wants_inputs:
        if paths:
            for path in paths:
                chunks.append(await read_bytes(path))
        elif stdin is not None:
            chunks.append(await _read_stdin_bytes(stdin))
    docs = assemble_inputs(chunks, opts)

    outputs: list[JsonValue] = []
    if opts.null_input:
        outputs.extend(
            jq_eval(None, expr, opts.named_args,
                    docs if wants_inputs else None, args_value))
    elif wants_inputs:
        # `inputs` consumes from the same stream the main loop reads, so a
        # program that drains it runs once. How much it drains is a
        # runtime fact libjq's Python binding does not report, so mirage
        # assumes the whole rest, which is what the idiom
        # (`[., inputs]`, `reduce inputs as $x`) does; a program that
        # takes only some of them (`first(inputs)`) would leave the
        # remainder for another pass in real jq and does not here.
        if docs:
            outputs.extend(
                jq_eval(docs[0], expr, opts.named_args, docs[1:], args_value))
    else:
        # jq applies the program to every document in the stream.
        for doc in docs:
            outputs.extend(
                jq_eval(doc, expr, opts.named_args, None, args_value))
    return format_jq_output(outputs,
                            opts), IOResult(exit_code=exit_code(outputs, opts))


__all__ = ["jq"]
