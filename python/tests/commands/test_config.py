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

from mirage.commands.config import (CommandOpts, RegisteredCommand, command,
                                    cross_command, has_injected_version,
                                    help_page, standard_request, version_line)
from mirage.commands.spec import SPECS, CommandSpec, Operand, Option
from mirage.commands.spec.builtin_specs import registered_spec
from mirage.version import __version__

_HANDLER_CALLS: list[str] = []


async def _noop_handler(backend, paths, texts, opts):
    return None, None


async def _recording_handler(backend, paths, texts, opts):
    _HANDLER_CALLS.append("called")
    return None, None


async def _collect(source):
    if isinstance(source, (bytes, bytearray)):
        return bytes(source)
    parts = []
    async for chunk in source:
        parts.append(chunk)
    return b"".join(parts)


class TestRegisteredCommand:

    def test_basic_fields(self):
        rc = RegisteredCommand(
            name="cat",
            spec=CommandSpec(rest=Operand(type="path")),
            vfs="ram",
            filetype=None,
            fn=lambda: None,
        )
        assert rc.name == "cat"
        assert rc.vfs == "ram"
        assert rc.filetype is None
        assert rc.provision_fn is None

    def test_with_filetype(self):
        rc = RegisteredCommand(
            name="grep",
            spec=CommandSpec(),
            vfs="s3",
            filetype=".parquet",
            fn=lambda: None,
        )
        assert rc.filetype == ".parquet"


class TestCommandDecorator:

    def test_decorator_attaches_registered_commands(self):
        spec = CommandSpec(rest=Operand(type="path"))

        @command("mytest", vfs="ram", spec=spec)
        async def my_fn(backend, paths, *texts, **kw):
            pass

        assert hasattr(my_fn, "_registered_commands")
        assert len(my_fn._registered_commands) == 1
        rc = my_fn._registered_commands[0]
        assert rc.name == "mytest"
        assert rc.vfs == "ram"

    def test_decorator_with_provision(self):
        spec = CommandSpec()

        async def my_provision(*a, **kw):
            pass

        @command("mytest", vfs="ram", spec=spec, provision=my_provision)
        async def my_fn(backend, paths, *texts, **kw):
            pass

        rc = my_fn._registered_commands[0]
        assert rc.provision_fn is my_provision

    def test_wrapping_a_registered_function_does_not_mutate_it(self):
        original = command("cat", vfs="s3", spec=CommandSpec())(_noop_handler)
        original_registrations = list(original._registered_commands)

        wrapped = command("cat", vfs="s3", spec=CommandSpec())(original)

        assert original._registered_commands == original_registrations
        assert (wrapped._registered_commands
                is not original._registered_commands)
        assert len(wrapped._registered_commands) == 2

    def test_write_defaults_false(self):
        rc = RegisteredCommand(
            name="cat",
            spec=CommandSpec(rest=Operand(type="path")),
            vfs="ram",
            filetype=None,
            fn=lambda: None,
        )
        assert rc.write is False

    def test_write_flag_true(self):
        rc = RegisteredCommand(
            name="rm",
            spec=CommandSpec(),
            vfs="s3",
            filetype=None,
            fn=lambda: None,
            write=True,
        )
        assert rc.write is True


class TestRegisteredCommandRead:

    def test_read_defaults_false(self):
        rc = RegisteredCommand(
            name="stat",
            spec=CommandSpec(),
            vfs="s3",
            filetype=None,
            fn=lambda: None,
        )
        assert rc.read is False

    def test_read_flag_true(self):
        rc = RegisteredCommand(
            name="cat",
            spec=CommandSpec(),
            vfs="s3",
            filetype=None,
            fn=lambda: None,
            read=True,
        )
        assert rc.read is True

    def test_with_overrides_preserves_read(self):
        rc = RegisteredCommand(
            name="cat",
            spec=CommandSpec(),
            vfs="s3",
            filetype=None,
            fn=lambda: None,
            read=True,
        )
        assert rc.with_overrides(fn=lambda: None).read is True

    def test_decorator_passes_read_through(self):
        spec = CommandSpec()

        @command("cat", vfs="ram", spec=spec, read=True)
        async def my_cat(backend, paths, *texts, **kw):
            pass

        assert my_cat._registered_commands[0].read is True


class TestCommandDecoratorWrite:

    def test_write_flag_passed_through(self):
        spec = CommandSpec()

        @command("rm", vfs="ram", spec=spec, write=True)
        async def my_rm(backend, paths, *texts, **kw):
            pass

        rc = my_rm._registered_commands[0]
        assert rc.write is True

    def test_write_flag_defaults_false(self):
        spec = CommandSpec()

        @command("cat", vfs="ram", spec=spec)
        async def my_cat(backend, paths, *texts, **kw):
            pass

        rc = my_cat._registered_commands[0]
        assert rc.write is False


class TestCrossCommandDecorator:

    def test_cross_command_fields(self):
        spec = CommandSpec()

        @cross_command("cp", src="s3", dst="disk", spec=spec)
        async def my_cp(ws, paths, *texts, **kw):
            pass

        rc = my_cp._registered_commands[0]
        assert rc.name == "cp"
        assert rc.src == "s3"
        assert rc.dst == "disk"
        assert rc.vfs == "s3->disk"


class TestVersionSupport:

    def test_auto_injects_version_option(self):
        registered = command("foo", vfs="disk",
                             spec=CommandSpec())(_noop_handler)
        longs = [
            o.long for o in registered._registered_commands[0].spec.options
        ]
        assert "--version" in longs
        assert "--help" in longs

    def test_version_short_circuits_handler(self):
        _HANDLER_CALLS.clear()
        registered = command("tsort", vfs="disk",
                             spec=CommandSpec())(_recording_handler)
        stdout, result = asyncio.run(registered._registered_commands[0].fn(
            None, [], [], CommandOpts(flags={"version": True})))
        assert _HANDLER_CALLS == []
        assert asyncio.run(
            _collect(stdout)) == f"tsort (Mirage) {__version__}\n".encode()
        assert result.exit_code == 0

    def test_help_keeps_the_spec_epilog(self):
        registered = command(
            "foo", vfs="disk",
            spec=CommandSpec(epilog="Services:\n  drive"))(_noop_handler)
        rc = registered._registered_commands[0]
        assert rc.spec.epilog == "Services:\n  drive"
        stdout, result = asyncio.run(
            rc.fn(None, [], [], CommandOpts(flags={"help": True})))
        assert b"Services:\n  drive\n" in asyncio.run(_collect(stdout))
        assert result.exit_code == 0

    def test_declared_version_reaches_the_handler(self):
        _HANDLER_CALLS.clear()
        registered = command("custom",
                             vfs=None,
                             spec=CommandSpec(options=(Option(
                                 long="--version"), )))(_recording_handler)
        asyncio.run(registered._registered_commands[0].fn(
            None, [], [], CommandOpts(flags={"version": True})))
        assert _HANDLER_CALLS == ["called"]


class TestStandardRequest:

    def test_matches_injected_option(self):
        registered = command("tsort", vfs="disk",
                             spec=CommandSpec())(_noop_handler)
        spec = registered._registered_commands[0].spec
        assert standard_request(
            "tsort", spec,
            ["--version"]) == f"tsort (Mirage) {__version__}\n".encode()

    def test_none_without_the_flag(self):
        registered = command("tsort", vfs="disk",
                             spec=CommandSpec())(_noop_handler)
        spec = registered._registered_commands[0].spec
        assert standard_request("tsort", spec, ["/data/a.txt"]) is None

    def test_none_after_end_of_options(self):
        registered = command("grep", vfs="disk",
                             spec=CommandSpec())(_noop_handler)
        spec = registered._registered_commands[0].spec
        assert standard_request("grep", spec, ["--", "--version"]) is None

    def test_none_for_unregistered_command(self):
        assert standard_request("nope", None, ["--version"]) is None

    def test_none_when_command_declares_its_own_version(self):
        spec = CommandSpec(options=(Option(long="--version"), ))
        registered = command("custom", vfs="disk", spec=spec)(_noop_handler)
        assert standard_request("custom",
                                registered._registered_commands[0].spec,
                                ["--version"]) is None

    # This runs ahead of the parser, and the parser expands an
    # abbreviation, so the two have to agree on what named the option: a
    # line that spans mounts never reaches the enriched spec (it parses
    # against the shared SPECS entry, which carries no --version), so an
    # exact-match-only check answered `cat --vers /ram/a` and refused
    # `cat --vers /ram/a /disk/b`.
    def test_matches_an_unambiguous_abbreviation(self):
        registered = command("tsort", vfs="disk",
                             spec=CommandSpec())(_noop_handler)
        spec = registered._registered_commands[0].spec
        for word in ("--vers", "--versio", "--v"):
            assert standard_request(
                "tsort", spec,
                [word, "/data/a.txt"
                 ]) == f"tsort (Mirage) {__version__}\n".encode()

    # A value is the parser's to refuse, in getopt_long's own words
    # (`option '--version' doesn't allow an argument`), so this declines
    # rather than answering.
    def test_none_for_an_abbreviation_carrying_a_value(self):
        registered = command("tsort", vfs="disk",
                             spec=CommandSpec())(_noop_handler)
        spec = registered._registered_commands[0].spec
        assert standard_request("tsort", spec, ["--versio=x"]) is None
        assert standard_request("tsort", spec, ["--version=x"]) is None

    # An abbreviation that names two options is not this option, and the
    # parser reports the ambiguity with both candidates.
    def test_none_for_an_ambiguous_abbreviation(self):
        spec = CommandSpec(options=(Option(long="--verbose"), ))
        registered = command("custom", vfs="disk", spec=spec)(_noop_handler)
        assert standard_request("custom",
                                registered._registered_commands[0].spec,
                                ["--ver"]) is None

    # expr reads a long option only when it is the whole line, and only
    # for expr's own grammar: a registered command that borrowed the
    # name answers wherever the word sits, like every other command.
    def test_the_sole_argument_window_is_the_builtins_alone(self):
        assert standard_request("expr", registered_spec("expr", SPECS["expr"]),
                                ["--versio"]) is not None
        assert standard_request("expr", registered_spec("expr", SPECS["expr"]),
                                ["--version", "x"]) is None
        borrowed = command(
            "expr", vfs="disk",
            spec=CommandSpec(rest=Operand(type="str")))(_noop_handler)
        assert standard_request("expr", borrowed._registered_commands[0].spec,
                                ["--version", "x"]) is not None

    # `--version` is an option like any other, so an option error the
    # scan meets FIRST is what GNU reports: measured on coreutils 9.7,
    # `cat --bogus --vers` is `cat: unrecognized option '--bogus'`
    # (exit 1) and `sort --bogus --version` is sort's own (exit 2).
    def test_a_refusal_the_scan_meets_first_outranks_the_version(self):
        for name in ("cat", "sort", "tee"):
            spec = registered_spec(name, SPECS[name])
            assert standard_request(name, spec, ["--bogus", "--vers"]) is None
            assert standard_request(name, spec,
                                    ["--bogus", "--version"]) is None

    # The mirror: coreutils answers INSIDE the getopt loop, calling
    # `version_etc` and exiting there, so a word the scan never reaches
    # cannot outrank it (`cat --version --bogus` prints the version and
    # exits 0 on 9.7).
    def test_a_refusal_the_scan_never_reaches_does_not(self):
        spec = registered_spec("cat", SPECS["cat"])
        assert standard_request("cat", spec, ["--version", "--bogus"])
        assert standard_request("cat", spec, ["--vers", "--bogus"])

    # grep sets `show_version` and keeps scanning, printing after the
    # loop, so a refusal anywhere outranks the answer; ripgrep's clap
    # parse is whole-line for the same reason. Measured on grep 3.11 and
    # ripgrep 14.1.1: both `--version --bogus` lines exit 2.
    def test_the_deferred_family_reads_the_whole_line(self):
        for name in ("grep", "rg"):
            spec = registered_spec(name, SPECS[name])
            assert standard_request(name, spec, ["--version"])
            assert standard_request(name, spec,
                                    ["--version", "--bogus"]) is None
            assert standard_request(name, spec,
                                    ["--bogus", "--version"]) is None

    # zgrep is a shell script whose own loop answers before it ever
    # builds a grep command, so no refusal outranks it (measured on gzip
    # 1.13: `zgrep --bogus --version f.gz` prints the version, exit 0,
    # where `zgrep --bogus f.gz` reaches grep and exits 2).
    def test_zgrep_answers_ahead_of_every_refusal(self):
        spec = registered_spec("zgrep", SPECS["zgrep"])
        assert standard_request("zgrep", spec, ["--bogus", "--version"])

    # A value-taking option swallows the word, so it is that option's
    # value and never an option at all: `grep -e --version f` greps for
    # the pattern `--version` and exits 1 on grep 3.11. The prefix
    # carries getopt's own `needs_value` refusal, which is what declines
    # here and leaves the word to the parser.
    def test_a_value_taking_option_swallows_the_word(self):
        spec = registered_spec("grep", SPECS["grep"])
        assert standard_request("grep", spec, ["-e", "--version"]) is None
        assert standard_request("grep", spec,
                                ["--include", "--version"]) is None

    # GNU answers both standard options from one long_options table, so
    # they are ordered against each other by scan position like any
    # other pair: measured on coreutils 9.7, `cat --help --version` is
    # the help page and `cat --version --help` is the version line. The
    # version half used to be the only one served here, so it won
    # wherever it sat.
    def test_the_first_standard_option_the_scan_reaches_wins(self):
        spec = registered_spec("cat", SPECS["cat"])
        assert standard_request("cat", spec,
                                ["--help", "--version"]) == help_page(
                                    "cat", SPECS["cat"])
        assert standard_request("cat", spec,
                                ["--version", "--help"]) == version_line("cat")
        assert standard_request("cat", spec, ["--h", "--v"]) == help_page(
            "cat", SPECS["cat"])

    # --help is served here for the same reason --version is: the
    # cross-mount branch bypasses the registered wrapper that answers it,
    # so `mv --help /ram/a /disk/b` ran the relay and moved the file. The
    # page must be the one the wrapper would have printed, GNU's synopsis
    # line included, which is why help_page takes either form of the
    # builtin's grammar.
    def test_help_is_served_from_either_form_of_the_grammar(self):
        for name in ("mv", "cp", "cat", "rm"):
            declared = SPECS[name]
            page = standard_request(name, registered_spec(name, declared),
                                    ["--help"])
            assert page == help_page(name, declared)
            assert f"Usage: {name}".encode() in page

    # The scan-order and family rules hold for help exactly as for the
    # version, which is measured rather than assumed: on coreutils 9.7
    # `cat --bogus --help` reports the option (exit 1) and
    # `cat --help --bogus` prints the page; on grep 3.11 BOTH orders
    # report the option, since grep prints after the loop; on gzip 1.13
    # `zgrep --bogus --help` prints zgrep's own usage and exits 0.
    def test_help_follows_the_same_scan_order_and_families(self):
        cat = registered_spec("cat", SPECS["cat"])
        assert standard_request("cat", cat, ["--bogus", "--help"]) is None
        assert standard_request("cat", cat, ["--help", "--bogus"])
        for name in ("grep", "rg"):
            spec = registered_spec(name, SPECS[name])
            assert standard_request(name, spec, ["--help"])
            assert standard_request(name, spec, ["--help", "--bogus"]) is None
            assert standard_request(name, spec, ["--bogus", "--help"]) is None
        zgrep = registered_spec("zgrep", SPECS["zgrep"])
        assert standard_request("zgrep", zgrep, ["--bogus", "--help"])

    # The position comes from the parser, not from a raw lookalike: `-e`
    # takes `--` as its pattern, so the line is NOT ended and the
    # `--version` after it is the option; `-o` takes the first
    # `--version` as its output file and the second is the option. The
    # raw scan stopped at the consumed word and declined, which on a
    # cross-mount line let the fan-out print one version page per
    # operand.
    def test_the_position_comes_from_the_parser_not_a_lookalike(self):
        grep = registered_spec("grep", SPECS["grep"])
        assert standard_request(
            "grep", grep, ["-e", "--", "--version"]) == version_line("grep")
        srt = registered_spec("sort", SPECS["sort"])
        assert standard_request(
            "sort", srt,
            ["-o", "--version", "--version"]) == version_line("sort")
        # A real end-of-options marker still ends the scan.
        assert standard_request("grep", grep, ["--", "--version"]) is None

    # A declared remainder slot is argparse's REMAINDER: the first
    # operand ends option parsing, so every word after it belongs to the
    # program being run rather than to mirage. Verified against argparse
    # itself -- `add_argument("--version", action="store_true")` plus
    # `add_argument("rest", nargs=REMAINDER)` answers `["operand",
    # "--version"]` with `version=False` and the flag in `rest`. mirage's
    # parser already agreed; only this scan did not, so `mytool operand
    # --version` printed mirage's version and the handler never ran.
    def test_a_remainder_operand_keeps_the_words_after_it(self):
        spec = CommandSpec(rest=Operand(type="str", remainder=True))
        registered = command("mytool", vfs="disk", spec=spec)(_noop_handler)
        rest_spec = registered._registered_commands[0].spec
        assert standard_request("mytool", rest_spec,
                                ["operand", "--version"]) is None
        assert standard_request("mytool", rest_spec,
                                ["operand", "--vers"]) is None
        # Ahead of the first operand it is still an option, as argparse
        # answers `["--version", "operand"]` with version=True.
        assert standard_request("mytool", rest_spec, ["--version", "operand"])
        assert standard_request("mytool", rest_spec, ["--version"])

    # The four builtin specs that declare a remainder (python, python3,
    # node, js) all declare their own --version too, so none of them ever
    # reaches the scan: the wrapper injects nothing and this declines on
    # the first line. Pinned so a spec losing its own --version cannot
    # quietly hand its program's argv to mirage.
    def test_the_builtin_remainder_specs_never_reach_the_scan(self):
        for name in ("python", "python3", "node", "js"):
            spec = registered_spec(name, SPECS[name])
            assert not has_injected_version(spec)
            assert standard_request(name, spec,
                                    ["-c", "code", "--vers"]) is None

    # Both tables name one real program, so both are gated on the spec
    # being that program's own grammar. A mount may register a command
    # under a builtin's name (nothing refuses it), and neither gnulib's
    # deferral nor zgrep's precedence is a fact about that command.
    def test_a_borrowed_name_does_not_borrow_the_family(self):
        for name in ("grep", "zgrep"):
            borrowed = command(
                name, vfs="disk",
                spec=CommandSpec(rest=Operand(type="str")))(_noop_handler)
            spec = borrowed._registered_commands[0].spec
            assert standard_request(name, spec, ["--version", "--bogus"])
            assert standard_request(name, spec,
                                    ["--bogus", "--version"]) is None
