---
name: mirage-vfs-authoring
description: Build or extend a custom Mirage VFS adapter for a user's API, database, object store, or application data. Use when connecting a new resource to Mirage, implementing a backend, or packaging a reusable adapter. For reading or editing data in an existing mount, use the filesystem workflow instead.
---

# Author a Mirage VFS

Deliver an adapter in the user's project, a working mount configuration, and
tests of its filesystem behavior. Subclass `BaseVFS` and define the functions the resource supports. A normal custom backend needs no Mirage fork.

## Start from the bundled adapter

For a new backend, run `python scripts/new_adapter.py --language python --output <project>/resource.py` from this skill directory, or select `typescript` and a
`.ts` output. The script refuses to overwrite an existing file. The generated
adapter uses only an in-memory fixture and includes a read-contract check plus a
mounted shell smoke test. Run Python with the project's Mirage environment, or
TypeScript with its `tsx` runner and `@struktoai/mirage-node` dependency.

Replace the fixture client with the resource API, then update the fixture paths
and expected bytes. Keep credentials in the application's configuration. The
self-contained templates are [Python](assets/adapter.py) and
[TypeScript](assets/adapter.ts); no repository checkout is needed to scaffold.

## Establish the resource contract

Inspect the project's Mirage version, language, runtime, and existing client.
Use the installed API and matching source or documentation; the interface is
still evolving. Ask only for missing decisions that affect the implementation:
which resources are visible, the mount prefix, credentials, and required writes.

Reuse a builtin VFS when it already represents the resource. For a new adapter,
define a small example tree and what each leaf renders before implementing it.
Separate stored bytes from rendered records, and distinguish a complete
directory from a paginated or time-windowed view. Use stable resource identities
when display names can collide or change.

Consult the relevant language's guide and runnable example, using the revision
matching the target Mirage package:

- [Python guide](https://github.com/strukto-ai/mirage/blob/main/docs/python/vfs/new.mdx)
  and [example](https://github.com/strukto-ai/mirage/blob/main/examples/python/other/custom_vfs.py).
- [TypeScript guide](https://github.com/strukto-ai/mirage/blob/main/docs/typescript/vfs/new.mdx)
  and [example](https://github.com/strukto-ai/mirage/blob/main/examples/typescript/other/custom_vfs.ts).

## Implement the smallest VFS

Keep backend access async. An `Accessor` owns the client; implement its cleanup
when the adapter owns connections. Reuse connections across calls. Python
constructors and `build_vfs` are synchronous: perform network initialization
lazily in async operations. TypeScript class references can use `static async create` when initialization requires I/O.

Subclass `BaseVFS` and define these functions over `PathSpec`:

- `readdir`: return immediate child virtual paths in the format the installed
  example uses. Avoid fetching each child's contents just to list a directory.
- `read`: return the exact bytes represented by a leaf. It also receives an
  `offset` and `size`; leave `reads_ranges` / `readsRanges` false and Mirage
  cuts the window from the whole read.
- `stat`: classify the entry and return its rendered byte length, or
  `None` / `null` when the length is unknown without reading it.

Those three are the whole minimal VFS. Mirage derives streaming from `read`
and existence from `stat`, and defaults to a remote resource. A derived stream
still fetches the entire file; it is not a memory-efficient stream.

Builtin backends define these same functions. Core functions need not inherit
a class: call them from the methods and wrap client-specific arguments or
return values at the VFS boundary. The shared types live in `vfs/types`.

Define more functions independently as the resource needs them. A function
the VFS does not define answers `Operation not supported`:

- `read_stream` / `readStream`, `exists`, `find`, and `du_size` with
  `du_entries` / `duSize` with `duEntries` are native fast paths. They
  preserve the baseline read semantics. Set `reads_ranges` / `readsRanges`
  when `read` fetches only the asked window: `offset` plus `size` is an
  exclusive end, and an omitted size reads through EOF.
- `search` is optional resource search for the `search` command, over a
  `PathSpec` and `SearchQuery` with `query` text and backend-defined JSON
  `options`. No regex support or grep compatibility is assumed. Return text
  records, an empty list for no matches, or `None` / `null` to decline.
  Validate resource-specific options and propagate failures. Define optional
  `search_many` / `searchMany` when ranking and limits must apply once across
  several scopes.
- `files_containing` / `filesContaining` and `lines_containing` /
  `linesContaining` let grep and rg skip reads: the files under a directory,
  or the lines of one file, that may hold a plain text. Answer every match or
  return `None` / `null`; a missed hit is a wrong answer. `before_full_scan` /
  `beforeFullScan` may raise to refuse a scan no search could narrow.
- `write`, `append`, `pwrite`, `create`, `mkdir`, `unlink`, `rmdir`, `rm_r` /
  `rmR`, `rename`, `copy`, `truncate`, and `setattr` are individual mutations.
  Defining `write` does not imply deletion, rename, or directory support;
  `append` and `pwrite` are built from `read` and `write` when the VFS does
  not define them. Mount mode still enforces which supported writes may
  execute.

A function only your class declares is reachable through the dispatcher by
name once it is marked `@vfs_call(effect=Effect.READ)` /
`@vfsCall({ effect: Effect.READ })`; the effect tells a read-only mount and
its policies what the call does. Use the installed version's signatures,
including optional index parameters. Older versions assembled a `VFSAdapter`
of callbacks instead of methods; follow the guide matching the installed
package.

Give the VFS a unique name and a concise prompt describing the tree and
rendering. Let Mirage derive commands, globbing, and dispatcher ops from the
functions it defines. Add bespoke commands or overrides for behavior the
generic operations cannot express.

Scope belongs in the resource operations too: a direct read, stream, range
read, or ID-addressed command must not bypass filters enforced by listing.
Prove parent membership or resolve through a scoped index. An incomplete
listing cannot prove an unlisted resource absent. Use Mirage's existing
hierarchy/index helpers when their documented contract fits; do not import
private helpers merely to shorten the adapter.

Grep/rg optimizations must return the same matches as searching the rendered
bytes. Fall back to scanning when equivalence is uncertain. Respect read
budgets before eagerly materializing results, and report incomplete output.

## Wire configuration and state

For an embedded application, mount the VFS instance directly. For YAML or a
reusable package, use the supported class reference or registration path:

- Python: `CONFIG_CLS` with `register_vfs`, a `mirage.vfs` package entry point,
  or a `./backend.py:ResourceVFS` reference.
- TypeScript: `registerVfsFactory` or a Node-loadable
  `./backend.mjs:ResourceVFS` reference. Do not assume a browser can load a
  local Node module.

Validate config at this boundary. Python models should explicitly forbid
unknown keys; TypeScript needs runtime validation, not a type assertion.
Use the host's credential mechanism and secret types; avoid serializing
credentials into state or errors.

Keep the default `needs_override` state for a live external resource unless
reconstruction is deliberately implemented. For Mirage-owned in-memory data,
implement state save/load and test restoration. Enable snapshot fingerprints,
read revalidation, and known-size claims only when the operations fulfill
those contracts.

## Verify and deliver

Exercise the adapter through `Workspace`, with a fake service or fixture:

- Listing, reading, stat, globbing, and a representative search agree.
- Nested mount prefixes resolve correctly; missing paths fail consistently.
- Direct reads of excluded resources fail even when their IDs are known.
- Pagination and read limits do not silently omit data or prove false absence.
- A read-only mount refuses supported writes before the mutation reaches the
  service; unsupported operations fail clearly.
- Config typos fail, owned clients close, and promised state restoration works.

Use the user's language for an external adapter. When contributing a Mirage
builtin, follow the repository's mirrored Python/TypeScript layout and gates,
and add shared integration cases for observable shell behavior.

Deliver the adapter, exact mount configuration, and verification results.
State which operations and state behavior are supported, and identify any
live-service checks that could not be run.

## Reuse the conformance check

Run `check_read_contract` / `checkReadContract` with a `ReadFixture` describing a
small known file, its parent, an absent sibling, and expected bytes. This checks
listing, stat, byte reads, streams, native ranges, existence, and missing-path
errors without mutating the resource. It takes the VFS itself, so the same
probe works for builtins and external backends.

Add backend-specific tests for pagination, authorization errors, and query options.
Use disposable fixtures for mutation tests. Verify a read-only mount refuses
writes and preserves the fixture. Do not run write probes against production data.
