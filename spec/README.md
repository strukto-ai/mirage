# Command Spec Exports

One JSON file per builtin command per implementation, dumped from the live
registries. `python/general` is the Python surface; `typescript/node` and
`typescript/browser` are the two TypeScript package pairings (`core` + `node`,
`core` + `browser`).

Each file carries the parsed spec (description, epilog, options, positional
operands, rest operand, ignored tokens) plus a `_meta` block recording which
resources register the command and whether any registration carries a
provision, an aggregate, or the write flag.

`_meta.by_resource` keys those same facts by the registering resource. The
union flags cannot say *which* backend carries a provision, so dropping one
backend's provision while another keeps it leaves every union unchanged. The
parity check compares per resource for that reason, and falls back to the
unions only once the per-resource entries agree. Registrations with no
resource (the general commands) are keyed under the empty string.

```bash
# Regenerate
./python/.venv/bin/python scripts/gen_specs.py
node --experimental-strip-types typescript/scripts/gen-specs.ts

# Compare the two implementations
./python/.venv/bin/python scripts/check_spec_parity.py
```

## The two CI gates

`Spec drift` regenerates both trees and fails if the committed JSON moved,
so the checked-in surface always matches the code.

`Spec parity` runs `scripts/check_spec_parity.py`, which diffs Python against
TypeScript command by command: every option (including its help text, value
kind, repeatability and shorthand form), every operand, the resource set each
command registers under, and the per-resource metadata. Resources are compared
against the union of the `node` and `browser` variants, since Python has no
runtime split.

The comparison walks the **union of the keys both sides emit** rather than a
fixed field list. Python dumps with `asdict(spec)`, so a new `CommandSpec` or
`_meta` field appears in its tree on its own, while `gen-specs.ts` serializes
through hand-written literals and would not. With an allowlist that asymmetry
was invisible: both drift gates still passed, because each tree regenerated
byte-identically, and parity never looked at the new key. The two TypeScript
variants are also diffed against each other, since Python is compared against
`node` and nothing else would otherwise read `spec/typescript/browser`'s
non-`_meta` content.

## `resources.json`

One per implementation tree, beside `general/`. Registry membership is a
*different table* from command registration, and only the second was ever
dumped — so a resource could register commands under every backend's `_meta`
while `build_resource` / `buildResource` had no factory for it. That is how
Python shipped without a `sharepoint` factory and the TypeScript registries
without chroma/dify/lancedb/qdrant while every command spec stayed identical.

Each file records `registry` (what can be constructed by name) and
`command_resources` (what registers at least one builtin command). The gate
asserts `command_resources ⊆ registry` per tree, and that Python's registry
equals the union of the two TypeScript ones. Deliberate omissions — the
workspace-internal `history` view mount — are declared under
`unconstructible_resources.<tree>` and stale-checked like every other
exemption. `python/tests/resource/test_registry.py` and
`packages/node/src/resource/registry.test.ts` both read these files instead of
re-copying the name list, so neither can pin an omission the way the old
hand-written set pinned SharePoint's.

Divergences that are structural rather than bugs live in
`parity_exceptions.json`:

- `resource_expansions` — one implementation registers a command once for a
  name that stands for several resource kinds. Python's HF commands declare
  `hf_buckets` and the datasets/models/spaces resources rebind them at
  construction, where TypeScript names all four up front.
- `language_only_resources` — a backend that exists in only one runtime, such
  as the browser's OPFS.
- `commands` — per-command exemptions. `fields` mutes a whole top-level field;
  `by_resource` names one resource and one metadata key, so an exemption
  cannot quietly hide a second divergence on the same command.

The checker fails on a *stale* exception, so an entry cannot outlive the
divergence it documents. An exemption counts as used only when it actually
suppresses a live divergence, not merely by being listed.

## Keeping the dump complete

`gen-specs.ts` can only see command groups the package index re-exports, so it
asserts that every `*_COMMANDS` declared by a builtin command module is
reachable. A backend that defines commands but forgets the re-export used to
drop out of the dump silently; now generation fails.

`gen_specs.py` has the same hazard from the other direction: a command module
that will not import registers nothing, so a venv missing the optional extras
quietly drops every backend behind them. Regenerating in that state looks like
a legitimate deletion of thousands of committed lines. Generation now names
the modules that failed to import and exits without writing, so run
`cd python && uv sync --all-extras --no-extra camel` first.
