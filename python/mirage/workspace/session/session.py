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

from collections.abc import Iterator, Mapping
from collections.abc import Set as AbstractSet
from dataclasses import dataclass, field, replace
from typing import Any, TypeVar

from mirage.cache.versions import VersionHistory
from mirage.execution.job.table import JobTable
from mirage.execution.job.waits import JobWaits
from mirage.execution.process.config import ProcessPermissions
from mirage.io.async_line_iterator import SharedInput, release_inputs
from mirage.io.network import NetworkSetting
from mirage.policy.builtin.output_cap import command_limits_to_json
from mirage.policy.types import (
    AdmissionRules,
    Decision,
    HideReason,
    ProfileScripts,
)
from mirage.rs.session import ShellVars
from mirage.secrets.config import EnvVar
from mirage.shell.array import ShellArray
from mirage.shell.console import JobOutput, Terminal
from mirage.shell.constants import (
    BIN_PREFIX,
    IFS_DEFAULT,
    SHELL_ARGV0,
)
from mirage.shell.descriptors import Descriptor, StreamOwner
from mirage.shell.helpers import source_row
from mirage.shell.types import AliasExpansion, TSNodeLike
from mirage.shell.variable import (
    ManagedRef,
    ShellVar,
    VarAttr,
    attrs_from_letters,
    stored_attrs,
)
from mirage.types import (
    DEFAULT_VISIBILITY,
    HiddenPaths,
    HiddenVars,
    Limit,
    MountMode,
    ShowEntry,
    ShownPaths,
    Visibility,
)
from mirage.utils.clock import SystemClock
from mirage.utils.ids import IdSource, SystemIdSource
from mirage.workspace.session.constants import (
    INHERITED_FIELDS,
    STARTUP_VALUES,
)
from mirage.workspace.session.functions import (
    FunctionSite,
    function_sources,
)
from mirage.workspace.session.serialize import (
    commands_from_dict,
    commands_to_dict,
    decision_from_dict,
    decision_to_dict,
    scripts_from_dict,
    scripts_to_dict,
)
from mirage.workspace.types import StatusWriter

# The file-creation mask a fresh shell starts with, as bash's.
_FRESH_UMASK = 0o022

T = TypeVar("T")


def copy_state(value: Any) -> Any:
    """Copy one session field deeply enough that a child cannot write back.

    Args:
        value (Any): the field value.
    """
    if isinstance(value, ShellVars):
        return value.fork()
    if isinstance(value, dict):
        return {k: copy_state(v) for k, v in value.items()}
    if isinstance(value, set):
        return set(value)
    if isinstance(value, list):
        return list(value)
    return value


def vars_from_env(env: Mapping[str, str]) -> dict[str, ShellVar]:
    """Variable records for a plain name/value map.

    The one conversion from the shape an embedder speaks (a process
    environment) to the shape the session stores. Every seeded name is
    exported, because a process environment is by definition the
    exported set: these are the names the embedder means a child
    runtime to inherit, and `env_snapshot` hands on only what carries
    the attribute. Seeding them plain would leave them visible to `$X`
    and invisible to every runtime, which is not what an embedder
    passing an env dict is asking for.

    Args:
        env (Mapping[str, str]): the name/value pairs to seed.
    """
    exported = frozenset({VarAttr.EXPORT})
    return {name: ShellVar(value, exported) for name, value in env.items()}


def vars_from_dict(
    env: Mapping[str, str], attrs: Mapping[str, str]
) -> dict[str, ShellVar]:
    """Variable records for a stored session's two halves.

    The restore side of `to_dict`. `env` carries every scalar and
    `attrs` the letter cluster for the names that have one, so a name
    in `attrs` alone is bash's declared-but-unset third state
    (``export Z``) and restores with no value.

    Not `vars_from_env`: that one reads a bare map as a *process*
    environment and exports all of it, which is right for an embedder
    handing over an env dict and wrong here, where the attributes were
    recorded. Restoring through it promoted every plain ``X=hello`` to
    an exported one on the first reload.

    Args:
        env (Mapping[str, str]): stored ``name -> value`` pairs.
        attrs (Mapping[str, str]): stored ``name -> letters`` clusters.
    """
    out = {
        name: ShellVar(value, attrs_from_letters(attrs.get(name, "")))
        for name, value in env.items()
    }
    for name, letters in attrs.items():
        if name not in out:
            out[name] = ShellVar(None, attrs_from_letters(letters))
    return out


def vars_from_entries(
    entries: Mapping[str, str | EnvVar | Mapping[str, Any]],
) -> dict[str, ShellVar]:
    """Variable records for a workspace env block.

    The declaration side of the env plane: a bare string is the literal
    short form (exported, like `vars_from_env`), a mapping is coerced
    through `EnvVar`, and a managed entry becomes bash's third state --
    exported, unset -- carrying the pointer as `ManagedRef`. After this
    translation the session vars are the only truth the fill step
    reads.

    Args:
        entries (Mapping[str, str | EnvVar | Mapping[str, Any]]): the
            env block, name -> entry.
    """
    out: dict[str, ShellVar] = {}
    for name, entry in entries.items():
        if isinstance(entry, str):
            entry = EnvVar(value=entry)
        elif not isinstance(entry, EnvVar):
            entry = EnvVar.model_validate(entry)
        attrs = set()
        if entry.provider is not None:
            ref = ManagedRef(
                entry.provider,
                entry.ref,
                entry.key or name,
                entry.fetch == "eager",
            )
            attrs.add(VarAttr.EXPORT)
            if entry.readonly:
                attrs.add(VarAttr.READONLY)
            out[name] = ShellVar(None, frozenset(attrs), managed=ref)
            continue
        if entry.export:
            attrs.add(VarAttr.EXPORT)
        if entry.readonly:
            attrs.add(VarAttr.READONLY)
        out[name] = ShellVar(entry.value, frozenset(attrs))
    return out


def vars_to_fields(table: Mapping[str, ShellVar]) -> dict[str, Any]:
    """The stored shape of a bare variable table.

    The three keys a stored session writes (`to_dict`): ``env`` holds
    the plain scalars, ``var_attrs`` the letter clusters, ``managed``
    the pointers -- and a managed name serializes as its pointer, never
    its value, the same rule the session codec states. This exists for
    the workspace env template, a variable table with no session around
    it, so a snapshot or copy can carry the declaration.

    Args:
        table (Mapping[str, ShellVar]): the variable table.
    """
    managed = {
        name: var.managed
        for name, var in table.items()
        if var.managed is not None
    }
    fields: dict[str, Any] = {
        "env": {
            name: var.value
            for name, var in table.items()
            if isinstance(var.value, str) and name not in managed
        },
        "var_attrs": {
            name: stored_attrs(var) for name, var in table.items() if var.attrs
        },
    }
    if managed:
        refs: dict[str, dict[str, str]] = {}
        for name, ref in managed.items():
            entry = {"from": ref.source, "ref": ref.ref, "key": ref.key}
            if ref.eager:
                entry["fetch"] = "eager"
            refs[name] = entry
        fields["managed"] = refs
    return fields


def vars_from_fields(data: Mapping[str, Any]) -> dict[str, ShellVar]:
    """The variable table a `vars_to_fields` payload restores.

    `vars_from_dict` reads the two plain halves; each managed name then
    restores declared-but-unfetched, its value forced back to None so a
    payload that smuggles one in is discarded rather than trusted --
    exactly how `from_dict` restores a stored session's vars.

    Args:
        data (Mapping[str, Any]): the stored fields.
    """
    out = vars_from_dict(data.get("env") or {}, data.get("var_attrs") or {})
    for name, m in (data.get("managed") or {}).items():
        var = out.get(name, ShellVar(None, frozenset({VarAttr.EXPORT})))
        out[name] = replace(
            var,
            value=None,
            managed=ManagedRef(
                m["from"], m["ref"], m["key"], m.get("fetch") == "eager"
            ),
        )
    return out


class _Records(Mapping[str, T]):
    """A live, read-only view of the records holding one kind of value,
    as stored: hidden names and references are not resolved, and a
    lookup reads the one record it names.

    Args:
        records (ShellVars): the session's variables.
        kind (type[T]): the value's type.
    """

    __slots__ = ("_kind", "_records")

    def __init__(self, records: ShellVars, kind: type[T]) -> None:
        self._records = records
        self._kind = kind

    def __getitem__(self, name: str) -> T:
        var = self._records.get(name)
        if var is None or not isinstance(var.value, self._kind):
            raise KeyError(name)
        return var.value

    def __iter__(self) -> Iterator[str]:
        for name, var in self._records.records():
            if isinstance(var.value, self._kind):
                yield name

    def __len__(self) -> int:
        return sum(1 for _ in self)


class _Readonly(AbstractSet[str]):
    """A live view of the names ``readonly`` has marked.

    Args:
        records (ShellVars): the session's variables.
    """

    __slots__ = ("_records",)

    def __init__(self, records: ShellVars) -> None:
        self._records = records

    def __contains__(self, name: object) -> bool:
        if not isinstance(name, str):
            return False
        var = self._records.get(name)
        return var is not None and VarAttr.READONLY in var.attrs

    def __iter__(self) -> Iterator[str]:
        for name, var in self._records.records():
            if VarAttr.READONLY in var.attrs:
                yield name

    def __len__(self) -> int:
        return sum(1 for _ in self)


@dataclass
class SessionState:
    session_id: str
    versions: VersionHistory = field(
        default_factory=VersionHistory, repr=False, compare=False, kw_only=True
    )
    cwd: str = "/"
    # The spelling `cd` arrived at: `..` simplified textually, symlinks
    # left alone. bash reports it as `$PWD` and `pwd -L`, and applies the
    # next `cd`'s `..` to it. None whenever it would equal `cwd`, which is
    # every session that has not walked through a symlink. `cwd` stays
    # physical because it is what every operand resolves against.
    logical_cwd: str | None = None
    # One record per variable: value plus attributes. This is the whole
    # variable store -- `env`, `arrays` and `readonly_vars` are read-only
    # projections of it, so a name cannot be a scalar in one container
    # and an array in another, and an attribute cannot drift from the
    # value it describes.
    vars: ShellVars = field(default_factory=lambda: ShellVars.of({}))
    # The manager stamps it on the workspace clock.
    created_at: float = field(default_factory=SystemClock().now)
    functions: dict[str, str] = field(default_factory=dict)
    # The functions `readonly -f` has frozen. A set beside `functions`
    # rather than a flag on the source because readonly is the
    # session's property, not the definition's. Kept in step with the readonly
    # *variable* set only by name: `readonly -f f` and `readonly f` are
    # two different frozen things in bash, and each refuses in its own
    # voice.
    readonly_functions: set[str] = field(default_factory=set)
    # The functions `export -f` marked, which a nested shell inherits.
    exported_functions: set[str] = field(default_factory=set)
    last_exit_code: int = 0
    # `${PIPESTATUS[@]}`: the exit status of every segment of the last
    # pipeline, where a simple command is a one-segment pipeline. Written
    # only through `record_status` (`executor/statement.py`), the one
    # function `$?` goes through as well, so the two can never disagree.
    # Empty in a fresh shell, as bash's is: the first `${PIPESTATUS[*]}`
    # expands to nothing until a statement records one.
    pipe_status: tuple[int, ...] = ()
    # `${FUNCNAME[@]}`: the function frames on the call stack, innermost
    # first, a sourced file as `source` (`CallStack.function_names`).
    # Written where a frame is pushed and popped, and answered by the
    # arrays view before the store, so an assignment to it is ignored.
    # None once `unset FUNCNAME` has made it an ordinary name, as bash's
    # unset does for the rest of the shell.
    function_names: tuple[str, ...] | None = ()
    # Which line stamped the two fields above, so a cancelled line puts
    # back only what it overwrote. Two `execute()` calls can share one
    # session, and a restore of a snapshot older than a concurrent
    # line's finished status would resurrect a value the shell moved
    # past. Runtime identity, never serialized: a restored snapshot has
    # no line running on it.
    status_writer: StatusWriter | None = None
    # Where `$RANDOM` draws its first seed: the workspace's id source,
    # shared by every fork and never serialized.
    ids: IdSource = field(
        default_factory=SystemIdSource, repr=False, compare=False
    )
    shell_options: dict[str, bool] = field(default_factory=dict)
    # `shopt` options, kept apart from `set -o` ones because bash keeps
    # two vocabularies (`shopt -o` is the bridge). Only the names set
    # away from their default are stored; SHOPT_DEFAULTS supplies the
    # rest, so a listing prints every option bash knows.
    shopts: dict[str, bool] = field(default_factory=dict)
    # `alias NAME=VALUE` definitions. A subshell inherits them like a
    # forked shell would, and a nested `bash`/`sh` gets a copy that is
    # put back afterwards, the same rule functions already follow.
    aliases: dict[str, str] = field(default_factory=dict)
    # The file-creation mask. bash's default for a fresh shell, and
    # exactly what mirage's 644/755 defaults for a new entry are.
    umask: int = _FRESH_UMASK
    mount_modes: dict[str, MountMode] | None = None
    # What exists for this session: the profile's hides, shows, hidden
    # variables, process scope and allow list, compiled once. The views
    # and the op boundary read it; fork carries it, to_dict serializes.
    visibility: Visibility = DEFAULT_VISIBILITY
    # The operator's reasons for grouped hides: never rendered to the
    # agent (a reason on ENOENT would confirm the path exists),
    # persisted so the host's read-back entry points survive a restart.
    hide_reasons: tuple[HideReason, ...] = ()
    # The profile's admission rules, compiled: its allow list, its ask and
    # deny rules, and every rule its mount entries carry. One document,
    # so there is nothing above it to join with. A durable restriction
    # like hidden_paths, so it persists with the session record.
    commands: AdmissionRules | None = None
    # The profile's policy programs by method, run by ScriptPolicy at
    # that method. A durable restriction like commands, so it persists
    # with the session record.
    scripts: ProfileScripts = field(default_factory=dict)
    # The name of the profile the session runs under, None for an
    # unrestricted session. What an owner-rendering command prints as
    # the group. Stamped by the profile like script, so it persists.
    profile: str | None = None
    command_limits: dict[str, Limit] = field(default_factory=dict)
    # Where the session's lines may connect besides the workspace's
    # network, from its profile. A durable restriction like commands.
    network: NetworkSetting | None = None
    terminal_output: bool = True
    processes: ProcessPermissions = ProcessPermissions()
    process_id: int | None = None
    shell_pid: int | None = None
    process_depth: int = 0
    # How deep the shell this session runs is nested: the levels the shells
    # that started it had re-entered, which its call stack counts on from
    # (``CallStack.nesting``).
    shell_nesting: int = 0
    # The host's standing answers to asked lines (design 3.9): session
    # state like functions and cwd, persisted, read and written through
    # the manager by id so a fork shares them, never another session's.
    decisions: tuple[Decision, ...] = ()
    generation: int = 0
    last_bg_job_id: int | None = None
    positional_args: list[str] = field(default_factory=list)
    # What `$0` expands to. None is the shell itself; a nested `bash`/`sh`
    # sets it to the script file it is running, or to the name given after
    # `-c`, and restores it afterwards.
    script_name: str | None = None
    exit_trap: str | None = None
    exit_trap_inherited: bool = False
    # The `trap ... ERR` and `trap ... RETURN` actions, "" for an ignored
    # one, and whether the running scope hides each: a child shell lists
    # but runs neither unless `set -E` / `set -T`, and a scope that sets
    # one sees it. Live shell state, like the EXIT action.
    err_trap: str | None = None
    return_trap: str | None = None
    err_trap_hidden: bool = False
    return_trap_hidden: bool = False
    # Whether each action is running in this shell: bash runs neither
    # again until it finishes, whatever the action registers meanwhile. A
    # child shell starts with neither running.
    err_trap_running: bool = False
    return_trap_running: bool = False
    tty: Terminal = field(default_factory=Terminal, repr=False)
    job_output: JobOutput | None = field(default=None, repr=False)
    job_waits: JobWaits | None = field(default=None, repr=False)
    # A per-call line's jobs, which a callback in it reaches; None otherwise.
    job_table: JobTable | None = field(default=None, repr=False)
    # Transient `set -e` marker: True when the failure just returned
    # came from a short-circuited &&/|| branch or a `!`-negated command,
    # which bash exempts from errexit. Reset on every node execution.
    errexit_immune: bool = field(default=False, repr=False)
    # Whether the running command is in a context where bash ignores
    # `set -e`: an `if`/`while`/`until` test, the left of `&&`/`||`, or
    # after `!`. Everything run there, a function or a subshell included,
    # ignores it (`ignoring_errexit`); a child shell keeps the context.
    errexit_ignored: bool = field(default=False, repr=False)
    # Whether `set -e` is ending the shell: its statements unwind
    # without running ERR or RETURN again, as bash's exit leaves at once.
    errexit_exiting: bool = field(default=False, repr=False)
    # The records running prefix assignments set aside, held until put back.
    _prefix_saves: list[dict[str, ShellVar | None]] = field(
        default_factory=list, repr=False
    )
    # Hidden `getopts` state: the 1-based char offset within the current
    # word being scanned, plus the OPTIND value that offset belongs to.
    # A caller resetting OPTIND (e.g. to 1) makes the seen value stale,
    # which restarts the scan at the word's first letter, as bash 5.2
    # does: after `getopts ab o` reads `a` from `-ab`, `OPTIND=1` makes
    # the next one read `a` again, not `b`.
    _trap_status: int | None = field(default=None, repr=False)
    _getopts_pos: int = field(default=1, repr=False)
    _getopts_optind: int | None = field(default=None, repr=False)
    # A pipeline's per-segment statuses, parked by `handle_pipe` for the
    # statement boundary that closes it to claim. None between them.
    _pipe_status_pending: tuple[int, ...] | None = field(
        default=None, repr=False
    )
    # Alias bookkeeping. bash expands an alias when it *parses* the line
    # that uses it, so a definition takes effect from the next line read
    # (`alias x=..; x` on one line finds no `x`; the same two statements
    # on two lines do). mirage parses a whole program before running any
    # of it, so the rule is kept as a mark: each program loop entered
    # gets a parse id, a read is the (parse, row) a command began on
    # (`read_row`), and an alias changed in a read keeps the value that
    # read began with for the commands it read (`unalias x; x` still
    # runs `x`).
    # `_alias_expansion` tracks the text each alias inserted, so a value whose
    # first word is the alias itself (`alias ls='ls -1'`) stops there.
    # `exec` redirect-only state: where the shell's own stdout, stderr
    # and stdin point after a bare `exec > file` / `exec 2> file` /
    # `exec < file`. None is the terminal (the workspace's own output);
    # `""` is a closed descriptor (`exec >&-`), whose writes are
    # dropped. `exec_stdin` is the one descriptor an `exec <` opened:
    # every statement after it reads on from where the one before
    # stopped, across lines and into a child shell, which shares it as
    # bash's fork shares fd 0.
    # `exec_stdout_input` and `exec_stderr_input` are the read end a
    # stream holds after `exec 1<f` or `exec 1<&0`, which a dup shares
    # the offset of.
    descriptors: dict[int, Descriptor] = field(default_factory=dict)
    exec_stdout: str | None = None
    exec_stdout_append: bool = False
    exec_stdout_input: SharedInput | None = None
    exec_stderr: str | None = None
    exec_stderr_append: bool = False
    exec_stderr_input: SharedInput | None = None
    exec_stdin: SharedInput | None = None
    exec_stdin_unreadable: bool = False
    # What fd 0 holds when it is not its own read end: `CLOSED` after
    # `exec <&-`, a writing stream's identity after `exec 0<&1`, so a
    # later dup from fd 0 copies that (`exec 2<&0` then writes to
    # stdout) or is refused (`0: Bad file descriptor`); None for the
    # read end itself.
    exec_stdin_identity: str | None = None
    # The readers a fork inherited: its parent still holds them, so the
    # fork closing one never closes the parent's.
    _borrowed: list[SharedInput] = field(default_factory=list, repr=False)
    _parse_seq: int = field(default=0, repr=False)
    _parse_current: int = field(default=0, repr=False)
    # The row the running parse starts on in the text that spelled it: 0
    # for a line, a function's definition row for its body, which is
    # parsed again from its own source but reads aliases where it was
    # written.
    _parse_row: int = field(default=0, repr=False)
    # The same row as `$LINENO` counts it, every line as typed: a row the
    # parse joined to the next (a backslash before the newline) counts.
    _line_row: int = field(default=0, repr=False)
    # What the running parse's diagnostics name as their source: None for
    # the shell's own input, `environment` for a function defined there,
    # the file for one sourced; and the command running in it, whose line
    # is `$LINENO` (`line_number`).
    _parse_name: str | None = field(default=None, repr=False)
    # What a syntax error in the running parse leads with: `eval`'s
    # `bash: eval: `, a sourced file's `name: `; None for the shell's own
    # input, `bash: -c: ` (`syntax_head`).
    _parse_head: str | None = field(default=None, repr=False)
    _line_node: TSNodeLike | None = field(default=None, repr=False)
    # The row the next nested parse starts on, which a sourced file (0)
    # and the rest of an input read again (its own parse's) set; None
    # numbers it on from the running command's line, as `eval` and
    # `$( )` do, or from 0 for a shell's own input.
    _parse_from: int | None = field(default=None, repr=False)
    # The owner of this session's terminal streams, which an `exec` copy
    # of one names (`exec 3>&1`), and whether a line of the session is
    # running, whose outermost program routes what was written to them.
    # Each fork gets its own: a child shell writing to its parent's
    # terminal is writing to a stream it did not open.
    terminal: StreamOwner = field(default_factory=StreamOwner, repr=False)
    _line_open: bool = field(default=False, repr=False)
    # Per read that changed aliases, their values as it began (None: not
    # defined), for the commands of that read; per read that ran `shopt`
    # on `expand_aliases`, the option as it began. Released when the
    # typed line ends.
    _alias_marks: dict[tuple[int, int], dict[str, str | None]] = field(
        default_factory=dict, repr=False
    )
    _expand_aliases_marks: dict[tuple[int, int], bool] = field(
        default_factory=dict, repr=False
    )
    _alias_expansion: AliasExpansion | None = field(default=None, repr=False)
    # The aliases a running function's body expands, as its definition
    # saw them (``FunctionSite.aliases``); None reads the live table.
    _alias_view: dict[str, str] | None = field(default=None, repr=False)
    # Where each function was defined (``FunctionSite``), so its body
    # expands the aliases of that place and its approvals stand under
    # it; a function loaded from a stored session has none and runs as a
    # parse of its own.
    _function_sites: dict[str, FunctionSite] = field(
        default_factory=dict, repr=False
    )

    def open_inputs(self) -> list[SharedInput]:
        return [
            source
            for source in (
                self.exec_stdin,
                self.exec_stdout_input,
                self.exec_stderr_input,
                *(
                    descriptor.source
                    for descriptor in self.descriptors.values()
                ),
            )
            if source is not None
        ]

    async def release_inputs(self, inputs: list[SharedInput]) -> None:
        """Close the readers among ``inputs`` that this shell no longer
        names and did not inherit.

        Args:
            inputs (list[SharedInput]): the descriptors just let go.
        """
        await release_inputs(inputs, [*self.open_inputs(), *self._borrowed])

    async def close_inputs(self) -> None:
        """Close the readers this child shell opened, as it ends; the
        ones it inherited stay with the shell that opened them."""
        await release_inputs(self.open_inputs(), self._borrowed)

    def variables_to_dict(self) -> dict[str, Any]:
        """The record's keys the variables fill: ``env``, ``arrays``,
        ``assocs``, ``var_attrs`` and ``managed``."""
        # A managed name serializes as its pointer, never its value: a
        # stored session may leak only where a secret lives. `env` skips
        # the name (the fetched plaintext must not land in the record)
        # while `var_attrs` keeps its letters, so a payload with the
        # `managed` key stripped still restores the name as
        # attributed-unset rather than dropping it.
        records = self.vars.records()
        managed = {
            name: var.managed
            for name, var in records
            if var.managed is not None
        }
        # `env` is every scalar and `var_attrs` the letters set on the
        # names that carry any, rather than one key holding both: `env`
        # is the shape an embedder writes and another language reads, so
        # it stays a plain name/value map, and the attributes ride
        # beside it. Without the second key a reload could only guess,
        # and guessing "exported" turned every plain `X=hello` into an
        # exported one on the first round trip.
        data: dict[str, Any] = {
            "env": {
                name: var.value
                for name, var in records
                if isinstance(var.value, str) and name not in managed
            },
        }
        # Arrays ride beside `env`, which stays the plain name/value map
        # an embedder reads: an indexed array by index, an associative
        # one in the order its keys were first assigned.
        arrays = {
            name: {str(i): v for i, v in var.value.elements.items()}
            for name, var in records
            if isinstance(var.value, ShellArray)
        }
        if arrays:
            data["arrays"] = arrays
        assocs = {
            name: dict(var.value)
            for name, var in records
            if isinstance(var.value, dict)
        }
        if assocs:
            data["assocs"] = assocs
        # Always written, even empty, because its *presence* is the
        # discriminator: a payload without it is read as a bare process
        # environment and every name in it comes back exported. Writing
        # it only when non-empty made `export -n X` (or any session whose
        # last attribute was cleared) serialize as a process environment,
        # so the reload re-exported everything it held.
        data["var_attrs"] = {
            name: stored_attrs(var) for name, var in records if var.attrs
        }
        if managed:
            refs: dict[str, dict[str, str]] = {}
            for name, ref in managed.items():
                entry = {"from": ref.source, "ref": ref.ref, "key": ref.key}
                if ref.eager:
                    entry["fetch"] = "eager"
                refs[name] = entry
            data["managed"] = refs
        return data

    def to_dict(self, variables: bool = True) -> dict[str, Any]:
        """The session's record.

        Args:
            variables (bool): include the keys the variables fill; False
                leaves them out, for a flush that compares their store's
                version instead of reading them.
        """
        data: dict[str, Any] = {
            "session_id": self.session_id,
            "cwd": self.cwd,
            "created_at": self.created_at,
            "generation": self.generation,
        }
        if variables:
            data.update(self.variables_to_dict())
        if self.functions:
            data["functions"] = dict(self.functions)
        if self.readonly_functions:
            data["readonly_functions"] = sorted(self.readonly_functions)
        if self.exported_functions:
            data["exported_functions"] = sorted(self.exported_functions)
        # The rest of what a shell keeps between lines, each only when it
        # differs from a fresh shell's, so a host that forgets its memory
        # brings the session back as it was left.
        if self.aliases:
            data["aliases"] = dict(self.aliases)
        # Each function's body runs the aliases its definition saw, not
        # the ones defined since, so the view goes with it.
        views = {}
        for name, source in self.functions.items():
            site = self._function_sites.get(name)
            if site is not None and site.aliases is not None:
                if site.source == source:
                    views[name] = dict(site.aliases)
        if views:
            data["function_aliases"] = views
        if self.shell_options:
            data["shell_options"] = dict(self.shell_options)
        if self.shopts:
            data["shopts"] = dict(self.shopts)
        if self.umask != _FRESH_UMASK:
            data["umask"] = self.umask
        if self.logical_cwd is not None:
            data["logical_cwd"] = self.logical_cwd
        if self.exit_trap is not None:
            data["exit_trap"] = self.exit_trap
        if self.err_trap is not None:
            data["err_trap"] = self.err_trap
        if self.return_trap is not None:
            data["return_trap"] = self.return_trap
        if self.mount_modes is not None:
            data["mount_modes"] = {
                prefix: mode.value for prefix, mode in self.mount_modes.items()
            }
        vis = self.visibility
        if vis.paths is not None:
            data["hidden_paths"] = {
                "paths": list(vis.paths.paths),
                "patterns": list(vis.paths.patterns),
            }
        if vis.shown is not None:
            data["shown_paths"] = {
                "entries": [
                    {"path": e.path}
                    if e.mode is None
                    else {"path": e.path, "mode": e.mode.value}
                    for e in vis.shown.entries
                ]
            }
        if self.hide_reasons:
            data["hide_reasons"] = [
                {"patterns": list(g.patterns), "reason": g.reason}
                for g in self.hide_reasons
            ]
        if vis.vars is not None:
            data["hidden_vars"] = {
                "names": list(vis.vars.names),
                "patterns": list(vis.vars.patterns),
            }
        if self.commands is not None:
            data["commands"] = commands_to_dict(self.commands)
        if self.scripts:
            data["scripts"] = scripts_to_dict(self.scripts)
        if self.command_limits:
            data["command_limits"] = command_limits_to_json(
                self.command_limits
            )
        if self.network is not None:
            data["network"] = self.network
        if self.processes != ProcessPermissions():
            data["processes"] = self.processes.model_dump()
        if self.profile is not None:
            data["profile"] = self.profile
        if self.decisions:
            data["decisions"] = [decision_to_dict(d) for d in self.decisions]
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SessionState":
        recorded: dict[str, ShellVar] | None = None
        if "env" in data or "var_attrs" in data or "managed" in data:
            data = dict(data)
            env = data.pop("env", {})
            attrs = data.pop("var_attrs", None)
            managed = data.pop("managed", None)
            arrays = data.pop("arrays", {})
            assocs = data.pop("assocs", {})
            # No `var_attrs` at all means the payload is a bare process
            # environment -- an embedder's dict, or a record another
            # writer hand-built -- so every name in it is exported,
            # which is what a process environment means. With the key
            # present the attributes were recorded and are restored as
            # they were written.
            out_vars = (
                vars_from_env(env)
                if attrs is None
                else vars_from_dict(env, attrs)
            )
            for name, elements in arrays.items():
                out_vars[name] = ShellVar(
                    ShellArray({int(i): v for i, v in elements.items()}),
                    attrs_from_letters((attrs or {}).get(name, "")),
                )
            for name, entries in assocs.items():
                out_vars[name] = ShellVar(
                    dict(entries),
                    attrs_from_letters((attrs or {}).get(name, "")),
                )
            # A managed name restores declared-but-unfetched. The value
            # is forced back to None: a stored session must never carry
            # the plaintext, so one a tampered payload smuggles into
            # `env` is discarded rather than trusted.
            for name, m in (managed or {}).items():
                var = out_vars.get(
                    name, ShellVar(None, frozenset({VarAttr.EXPORT}))
                )
                out_vars[name] = replace(
                    var,
                    value=None,
                    managed=ManagedRef(
                        m["from"],
                        m["ref"],
                        m["key"],
                        m.get("fetch") == "eager",
                    ),
                )
            data["vars"] = out_vars
            if attrs is not None:
                recorded = out_vars
        for marks in ("readonly_functions", "exported_functions"):
            if marks in data:
                data = {**data, marks: set(data[marks])}
        # A session's own copies, so two loaded from one record share none.
        for table in ("aliases", "shell_options", "shopts"):
            if data.get(table) is not None:
                data = {**data, table: dict(data[table])}
        views = data.get("function_aliases")
        modes = data.get("mount_modes")
        paths = data.get("hidden_paths")
        shown = data.get("shown_paths")
        reasons = data.get("hide_reasons")
        vars_ = data.get("hidden_vars")
        commands = data.get("commands")
        scripts = data.get("scripts")
        decisions = data.get("decisions")
        limits = data.get("command_limits")
        processes = data.get("processes")
        data = {
            key: value
            for key, value in data.items()
            if key
            not in (
                "hidden_paths",
                "shown_paths",
                "hidden_vars",
                "function_aliases",
            )
        }
        if modes is not None:
            data["mount_modes"] = {
                prefix: MountMode(mode) for prefix, mode in modes.items()
            }
        if reasons is not None:
            data["hide_reasons"] = tuple(
                HideReason(
                    patterns=tuple(g.get("patterns", ())),
                    reason=g.get("reason", ""),
                )
                for g in reasons
            )
        if commands is not None:
            data["commands"] = commands_from_dict(commands)
        if scripts is not None:
            data["scripts"] = scripts_from_dict(scripts)
        if decisions is not None:
            data["decisions"] = tuple(decision_from_dict(d) for d in decisions)
        if limits is not None:
            data["command_limits"] = {
                name: Limit.model_validate(limit)
                for name, limit in limits.items()
            }
        if processes is not None:
            data["processes"] = ProcessPermissions.model_validate(processes)
        if (
            paths is not None
            or shown is not None
            or vars_ is not None
            or processes is not None
        ):
            data["visibility"] = Visibility(
                paths=(
                    HiddenPaths(
                        paths=tuple(paths.get("paths", ())),
                        patterns=tuple(paths.get("patterns", ())),
                    )
                    if paths is not None
                    else None
                ),
                shown=(
                    ShownPaths(
                        entries=tuple(
                            ShowEntry(
                                path=e["path"],
                                mode=(
                                    MountMode(e["mode"])
                                    if "mode" in e
                                    else None
                                ),
                            )
                            for e in shown.get("entries", ())
                        )
                    )
                    if shown is not None
                    else None
                ),
                vars=(
                    HiddenVars(
                        names=tuple(vars_.get("names", ())),
                        patterns=tuple(vars_.get("patterns", ())),
                    )
                    if vars_ is not None
                    else None
                ),
                processes=data.get("processes", ProcessPermissions()).list,
            )
        if "vars" in data:
            data["vars"] = ShellVars.of(data["vars"])
        session = cls(**data)
        # A function's alias view comes back as its site; where on its line
        # the definition stood went with the line.
        for name, view in (views or {}).items():
            if name in session.functions:
                session._function_sites[name] = FunctionSite(
                    session.functions[name], (0, 0), None, dict(view)
                )
        if recorded is not None:
            # A recorded session comes back as it was written, so a
            # startup variable it had unset stays unset rather than being
            # seeded again; a bare environment starts a new shell.
            session.vars = ShellVars.of(recorded, session.ids.random_u32)
        return session

    @property
    def argv0(self) -> str:
        """What ``$0`` expands to.

        None is the shell itself; a nested `bash`/`sh` sets it to the
        script it is running, or to the name given after `-c`. An empty
        name is a name, so it is not folded into the default: GNU
        ``bash -c 'echo "[$0]"' ""`` prints ``[]``.
        """
        return SHELL_ARGV0 if self.script_name is None else self.script_name

    @property
    def line_number(self) -> int:
        """The line of the command running, ``$LINENO``: its row in the
        text that spelled it, numbered on from where that text's parse
        starts (``_line_row``)."""
        node = self._line_node
        return self._line_row + (0 if node is None else source_row(node)) + 1

    @property
    def bash_pid(self) -> int:
        """The process running the command, ``$BASHPID``: the subshell,
        stage or substitution it runs in, else the shell itself."""
        return self.process_id or self.shell_pid or 0

    @property
    def env(self) -> Mapping[str, str]:
        """The scalar variables, by name.

        Read-only, so an assignment into it raises instead of landing in
        a throwaway dict. A writer goes through `SessionView.set` (or
        `seed_var` when seeding a session before it is narrowed), so a
        `pre_session` policy sees every write.
        """
        return _Records(self.vars, str)

    @property
    def arrays(self) -> Mapping[str, ShellArray]:
        """The indexed arrays, by name. Read-only, like `env`."""
        return _Records(self.vars, ShellArray)

    @property
    def assocs(self) -> Mapping[str, dict[str, str]]:
        """The associative arrays, by name. Read-only, like `env`."""
        return _Records(self.vars, dict)

    @property
    def readonly_vars(self) -> AbstractSet[str]:
        """The names `readonly` has marked. Read-only, like `env`."""
        return _Readonly(self.vars)

    def __setattr__(self, name: str, value: Any) -> None:
        if name == "vars" and not isinstance(value, ShellVars):
            ids = self.__dict__.get("ids")
            value = ShellVars.of(
                value, None if ids is None else ids.random_u32
            )
        object.__setattr__(self, name, value)
        # The shell draws a first `$RANDOM` seed from the session's ids, so
        # a new source, or a new shell, binds as it lands.
        if name in ("ids", "vars") and {"ids", "vars"} <= self.__dict__.keys():
            self.vars.shell.use_ids(self.ids.random_u32)
        # The shell holds the hidden names itself, so a new visibility,
        # or a new shell, takes them as it lands, wherever it is set.
        if (
            name in ("visibility", "vars")
            and {
                "visibility",
                "vars",
            }
            <= self.__dict__.keys()
        ):
            self.hide_vars()

    def hide_vars(self) -> None:
        """Hand the shell the names the session's visibility hides."""
        hidden = self.visibility.vars
        self.vars.shell.hide(
            [] if hidden is None else list(hidden.names),
            [] if hidden is None else list(hidden.patterns),
        )

    def __post_init__(self) -> None:
        self.functions = function_sources(self.functions)
        # bash exports `$PWD` from startup, so a session that has never
        # run `cd` still has one. Seeding here rather than at lookup time
        # is what makes it an ordinary variable: assignable, unsettable,
        # and listed by `env`. "Exports" is literal -- it carries the
        # attribute, which is what keeps it in `env` now that the
        # process view is the exported set rather than every string.
        self.vars.setdefault(
            "PWD", ShellVar(self.cwd, frozenset({VarAttr.EXPORT}))
        )
        # bash starts with a PATH when the environment gives it none, and
        # does not export it: `env` does not list it and a child process,
        # such as a host interpreter, keeps its own. The one directory here
        # is where every program's file is.
        self.vars.setdefault("PATH", ShellVar(BIN_PREFIX, frozenset()))
        # bash sets IFS at startup and never exports it, so a fresh shell
        # reads `${#IFS}` as 3 and `OLDIFS=$IFS ... IFS=$OLDIFS` puts the
        # default back rather than an empty IFS that splits nothing.
        self.vars.setdefault("IFS", ShellVar(IFS_DEFAULT, frozenset()))
        # bash starts OPTIND (an integer) and OPTERR at 1 and never exports
        # them, so `shift $((OPTIND-1))` works before any `getopts`.
        for name, var in STARTUP_VALUES.items():
            self.vars.setdefault(name, var)

    def fork(self, **overrides: Any) -> "SessionState":
        """Return a copy of this session with overrides applied.

        Every inherited field is copied deeply enough that mutations on
        the fork do not leak back into the source. The field list is
        INHERITED_FIELDS rather than a literal written out here, so a
        field added to the dataclass is propagated by construction.

        A caller that moves the fork with ``cwd`` supplies a physical
        path with no typed spelling behind it, so the source's logical
        name is dropped rather than left describing where the fork is
        not -- the same reasoning as `shell_dirs.set_cwd`. Deciding it
        here rather than at each call site is what keeps
        ``execute(cwd=...)`` from reporting the persistent session's old
        directory from ``pwd``.

        A fork is the same shell going on, so a startup variable the
        source unset stays unset (`unset IFS; ( ... )`) and the shell's
        records carry over whole; a fork given new variables starts them.

        Args:
            **overrides: Field-name kwargs to override on the copy.
        """
        return self._fork(overrides, None)

    def _fork(
        self, overrides: dict[str, Any], records: ShellVars | None
    ) -> "SessionState":
        given = {*overrides, *(() if records is None else ("vars",))}
        defaults: dict[str, Any] = {
            name: copy_state(getattr(self, name))
            for name in INHERITED_FIELDS
            if name not in given
        }
        defaults.update(overrides)
        if records is None and "vars" not in overrides:
            records = defaults["vars"]
        if records is not None:
            defaults["vars"] = ShellVars.of({})
        if "cwd" in overrides and "logical_cwd" not in overrides:
            defaults["logical_cwd"] = None
            # `$PWD` names where the session is, so it follows the move
            # even when the caller also supplied an env to layer on.
            moved = defaults["vars"] if records is None else records
            moved["PWD"] = ShellVar(
                overrides["cwd"], frozenset({VarAttr.EXPORT})
            )
        forked = SessionState(**defaults)
        if records is not None:
            forked.vars = records
        forked._borrowed = [*self._borrowed, *self.open_inputs()]
        return forked

    def subshell(self, records: ShellVars | None = None) -> "SessionState":
        """A child shell of this session: a fork that reads on from here.

        ``fork`` copies what a session keeps; a child shell (a command
        substitution, a subshell) also inherits the reader's position, the
        aliases being expanded and the local scopes, and reseeds
        ``$RANDOM`` on its first draw instead of replaying this session's
        seed.

        Args:
            records (ShellVars | None): the child's variables when a
                running expansion made them (a substitution's child
                shell); None copies this session's.
        """
        child = self._fork(
            {}, self.vars.subshell() if records is None else records
        )
        child._parse_current = self._parse_current
        child._parse_row = self._parse_row
        child._line_row = self._line_row
        child._parse_name = self._parse_name
        child._parse_head = self._parse_head
        child._line_node = self._line_node
        child._alias_expansion = self._alias_expansion
        return child

    def new_shell(self) -> "SessionState":
        """A new shell started from this session, as a nested ``bash`` is.

        bash runs a nested shell as a program of its own, which inherits
        the working directory, the umask, the open files and the
        environment: the exported variables, as plain exported strings
        (no array, no other attribute), and the functions ``export -f``
        marked. The rest starts as a fresh shell's does: the other
        variables and functions, the aliases, the ``set`` and ``shopt``
        options, ``$?``, ``$!``, ``$RANDOM``'s sequence, ``getopts``'s
        place, the call stack, any test its caller is in (``if bash -ec
        'false; ...'`` still ends at ``false``) and the startup
        variables, which bash never reads from its environment: IFS is
        dropped and ``STARTUP_VALUES`` restart. A managed variable not
        yet fetched crosses as its pointer, which the nested shell
        fetches through.

        Args:
            None
        """
        exported = frozenset({VarAttr.EXPORT})
        variables: dict[str, ShellVar] = {}
        for name, var in self.vars.records():
            if VarAttr.EXPORT not in var.attrs or name == "IFS":
                continue
            if not isinstance(var.value, str) and var.managed is None:
                continue
            start = STARTUP_VALUES.get(name)
            variables[name] = (
                ShellVar(var.value, exported, var.managed)
                if start is None
                else ShellVar(start.value, start.attrs | exported)
            )
        functions = {
            name: source
            for name, source in self.functions.items()
            if name in self.exported_functions
        }
        child = self.fork(
            vars=ShellVars.of(variables).subshell(),
            functions=functions,
            exported_functions=set(functions),
            readonly_functions=set(),
            _function_sites={
                name: site
                for name, site in self._function_sites.items()
                if name in functions
            },
            aliases={},
            _alias_marks={},
            _expand_aliases_marks={},
            shell_options={},
            shopts={},
            last_exit_code=0,
            pipe_status=(),
            last_bg_job_id=None,
            function_names=(),
            _getopts_pos=0,
            _getopts_optind=None,
            errexit_ignored=False,
        )
        return child

    def remove_function(self, name: str) -> None:
        """Remove a function with its definition site and export mark.

        Args:
            name (str): the function's name.
        """
        self.functions.pop(name, None)
        self._function_sites.pop(name, None)
        self.exported_functions.discard(name)
