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

from collections.abc import Callable
from dataclasses import dataclass, field, replace
from enum import StrEnum

from mirage.shell.array import ShellArray

ShellValue = str | ShellArray | dict[str, str]

# What one attributed write does to a scalar before it is stored.
# `-i` needs the arithmetic evaluator, which lives above this module,
# so the caller injects it rather than this leaf importing upward.
Coercer = Callable[[str], str]


class VarAttr(StrEnum):
    """One bash variable attribute, spelled as its `declare` letter.

    Declaration order is the order `declare -p` prints a cluster in,
    pinned exhaustively against bash 5.2.37 over all 72 ordered pairs
    of `a A i l n r t u x`: `a`/`A` first, then `i n r t x`, then
    `l`/`u`. It is bash's own internal order, not the order the letters
    were typed in (`declare -xri` prints `-irx`), and not alphabetical.

    `-a` and `-A` are deliberately absent: whether a variable is an
    indexed array, an associative array or a scalar is what its value
    *is*, so storing it a second time as an attribute would let the two
    contradict each other. `attr_letters` derives them from the value.
    """
    INTEGER = "i"
    NAMEREF = "n"
    READONLY = "r"
    TRACE = "t"
    EXPORT = "x"
    LOWER = "l"
    UPPER = "u"


class VarKind(StrEnum):
    """What a variable's value is, derived from the value itself."""
    SCALAR = "scalar"
    INDEXED = "indexed"
    ASSOC = "assoc"


@dataclass(frozen=True, slots=True)
class ManagedRef:
    """Where a managed variable's value comes from.

    A managed variable is an ordinary `ShellVar` carrying one of these:
    the pointer is host configuration (a YAML/in-app env entry), never
    something an agent line can spell, and it is what serializes -- the
    fetched value never does. All fill-step state rides here so a
    session can carry managed entries the workspace never declared.

    Args:
        source (str): registered source name (`env`, `dotenv`, `aws-sm`,
            or a user-registered one).
        ref (str): the source's address for one secret (a secret id, a
            dotenv path; `""` where the source has no sub-address).
        key (str): which field of the fetched secret this variable
            reads; defaults to the variable's own name at declaration.
        eager (bool): join every line's fetch set instead of waiting
            for a line that references the name.
    """
    source: str
    ref: str
    key: str
    eager: bool = False


@dataclass(frozen=True, slots=True)
class ShellVar:
    """One shell variable: a value plus the attributes set on it.

    Frozen on purpose. Every writer in the repo already computes its
    result on a copy and hands the finished value to the session door
    (`arr = list(arr)` before an element write, and so on), precisely so
    a refused write leaves nothing half-applied. Making the record
    immutable turns that convention into something the type enforces:
    the only way to change a variable is to hand the door a new record,
    so a policy gate cannot be walked around by reaching into storage.

    Args:
        value (ShellValue | None): the scalar text, indexed array, or
            associative map this variable holds. None is bash's third
            state: declared with attributes but *unset*, which
            `readonly NAME` and `export NAME` on a fresh name both
            produce. It is not the empty string -- GNU prints
            `declare -r ONLY` for one and `declare -r EMPTY=""` for the
            other, `${ONLY-d}` expands to `d` while `${EMPTY-d}` does
            not, and `env` carries the empty one but not the unset one.
        attrs (frozenset[VarAttr]): the attributes set on the name.
        managed (ManagedRef | None): set when the value comes from a
            secrets source. Unfetched is exactly the third state above:
            value None with attributes, so `env_snapshot`'s existing
            value check already omits it. `with_value` deliberately
            carries this field (the fill step writes through it) and
            `detach` is the agent-write arm.
    """
    value: ShellValue | None = None
    attrs: frozenset[VarAttr] = field(default_factory=frozenset)
    managed: ManagedRef | None = None


def var_kind(var: ShellVar) -> VarKind:
    """What kind of variable this is, read off its value.

    An unset variable reads as a scalar: bash renders `declare -i n`
    with no `-a`, so nothing but an actual array value earns the letter.

    Args:
        var (ShellVar): the variable.
    """
    if isinstance(var.value, dict):
        return VarKind.ASSOC
    if isinstance(var.value, list):
        return VarKind.INDEXED
    return VarKind.SCALAR


def with_value(var: ShellVar, value: ShellValue | None) -> ShellVar:
    """The variable with a new value and the same attributes.

    Args:
        var (ShellVar): the variable to copy.
        value (ShellValue | None): the value to store.
    """
    return replace(var, value=value)


def detach(var: ShellVar) -> ShellVar:
    """The variable with its managed pointer dropped, value kept.

    An agent write to a managed name shadows session-locally: the
    record becomes a plain variable for this session only, so the fill
    step never clobbers it and the declaration (new sessions fetch
    fresh) and the remote store are untouched by construction.

    Args:
        var (ShellVar): the variable to copy.
    """
    return replace(var, managed=None)


def with_attr(var: ShellVar, attr: VarAttr, on: bool = True) -> ShellVar:
    """The variable with one attribute turned on or off.

    `+attr` is the off direction, which is why this takes a flag rather
    than being two functions.

    Args:
        var (ShellVar): the variable to copy.
        attr (VarAttr): the attribute to change.
        on (bool): set it, or clear it.
    """
    attrs = var.attrs | {attr} if on else var.attrs - {attr}
    return replace(var, attrs=frozenset(attrs))


def coerce_scalar(text: str, attrs: frozenset[VarAttr],
                  integer: Coercer | None) -> str:
    """Apply the value-shaping attributes to one scalar being stored.

    bash applies these at assignment, not at read: `declare -l s; s=ABC`
    stores `abc`, and `declare -i n; n=2+2` stores `4`, so `declare -p`
    and `$s` agree with no per-read work. Order is integer first, then
    case, which only matters for hex digits and is what GNU does
    (`declare -il n=0xA` stores `10`).

    `-l` and `-u` cannot both hold; a declaration that sets one clears
    the other, so at most one applies here.

    Args:
        text (str): the incoming value.
        attrs (frozenset[VarAttr]): the attributes on the name.
        integer (Coercer | None): the arithmetic evaluation `-i` runs,
            None when the caller has no evaluator (a bare test).
    """
    if VarAttr.INTEGER in attrs and integer is not None:
        text = integer(text)
    if VarAttr.LOWER in attrs:
        return text.lower()
    if VarAttr.UPPER in attrs:
        return text.upper()
    return text


def coerce_value(value: ShellValue, attrs: frozenset[VarAttr],
                 integer: Coercer | None) -> ShellValue:
    """`coerce_scalar` lifted over every value shape.

    An array applies the attribute per element, which is GNU's
    `declare -ai a=(1+1 2*3)` giving `([0]="2" [1]="6")`.

    Args:
        value (ShellValue): the incoming value.
        attrs (frozenset[VarAttr]): the attributes on the name.
        integer (Coercer | None): the arithmetic evaluation `-i` runs.
    """
    if not (attrs & {VarAttr.INTEGER, VarAttr.LOWER, VarAttr.UPPER}):
        return value
    if isinstance(value, str):
        return coerce_scalar(value, attrs, integer)
    if isinstance(value, dict):
        return {k: coerce_scalar(v, attrs, integer) for k, v in value.items()}
    return [
        None if v is None else coerce_scalar(v, attrs, integer) for v in value
    ]


def stored_attrs(var: ShellVar) -> str:
    """The stored attribute letters, in `declare -p` print order.

    The tail of `attr_letters` without the `a`/`A` kind lead, which is
    derived rather than stored. Split out because two callers want the
    stored half alone: the serializer, which must not write a letter it
    would then read back as an attribute the value already implies, and
    `attr_letters` itself.

    Args:
        var (ShellVar): the variable.
    """
    return "".join(a.value for a in VarAttr if a in var.attrs)


def attrs_from_letters(letters: str) -> frozenset[VarAttr]:
    """The attribute set a stored letter cluster spells.

    The inverse of `stored_attrs`, used when a persisted session is read
    back. A letter that names no attribute is ignored rather than
    raising: the store is shared with the other language and with future
    versions, and refusing to load a session because one letter is
    unknown loses far more than the letter.

    Args:
        letters (str): the cluster written by `stored_attrs`.
    """
    known = {a.value: a for a in VarAttr}
    return frozenset(known[c] for c in letters if c in known)


def attr_letters(var: ShellVar) -> str:
    """The attribute cluster `declare -p` prints for this variable.

    `-a`/`-A` come from the value's kind and lead, then the stored
    attributes in `VarAttr` declaration order. bash prints `--` for a
    plain scalar with nothing set, which is the caller's to render since
    only it knows it is writing a `declare` line.

    Args:
        var (ShellVar): the variable.
    """
    kind = var_kind(var)
    lead = ""
    if kind == VarKind.INDEXED:
        lead = "a"
    elif kind == VarKind.ASSOC:
        lead = "A"
    return lead + stored_attrs(var)
