import type { FileStat } from '../../types.ts'

/** find's row actions: -print, -print0, -ls and -delete. */
export type RowActionKind = 'print' | 'print0' | 'ls' | 'delete'

/** The one-letter kind a -printf %y/%Y directive renders. */
export type PrintfKind = 'f' | 'd' | 'l' | 'c' | 'p'

export interface FindEntry {
  key: string
  name: string
  // 'l' is a namespace symlink: GNU find without -L reports the link
  // itself and never walks through it, so it is never 'f' or 'd'.
  kind: 'f' | 'd' | 'l' | 'c' | 'p'
  depth: number
  isEmpty?: boolean | null
  mtime?: number | null
  // The stat the walk took when a test reads one (-perm, -user, -lname,
  // -atime...), the link itself unless the walk follows links.
  stat?: FileStat | null
  // -xtype's kind: what a link leads to when the walk keeps links, 'l'
  // for a link the walk followed, the kind itself for anything else.
  xkind?: string | null
  // The stat of what a live link the walk keeps leads to, which the access
  // tests answer through.
  target?: FileStat | null
}

export type ActionKind = RowActionKind | 'exec' | 'printf'

// `-mtime`, `-newermt` and a resolved `-newer`: an inclusive epoch-second
// window over the entry's modification time. Only a test in the top-level
// `-a` chain also narrows the expression's flat window
// (`FindExpr.mtimeMin`/`mtimeMax`), which is what a backend pushes down and
// the generic post-filters with; the tree decides the rest, so a walk fetches
// mtimes whenever the tree holds one of these. An entry whose mtime is
// unknown passes here. The node also orders prunes: a `-prune` after it fires
// only for a directory the test holds for, and one before it fires
// regardless, as GNU orders them. A prune reached past an undecided test is
// recorded as pending for the caller to settle once it has statted the
// directory.
/**
 * `-mtime`, `-newermt` and a resolved `-newer`: an inclusive epoch-second
 * window over the entry's modification time, or over its access or
 * change time for `-atime`, `-ctime` and their minute twins (`field` `a`
 * or `c`, read from the entry's stat).
 */
export interface Mtime {
  op: 'mtime'
  lo: number | null
  hi: number | null
  field?: 'm' | 'a' | 'c'
}

// A directory whose `-prune` decision waited on time tests the walk could
// not decide: a prune reached past one, or every prune skipped on the
// strength of one (`-mtime 1 -o -prune`). The entry is kept whole: whether
// the prune stands is settled by evaluating the expression again with the
// directory's mtime, since a failing test may send GNU down another arm
// that prunes anyway (`( -mtime 1 -o -type d ) -prune`).
export interface PendingPrune {
  entry: FindEntry
}

export interface Name {
  op: 'name'
  pattern: string
  icase: boolean
}

/**
 * `-path` matches the row as `find` prints it: the mount prefix plus the
 * entry's key, respelled under the operand as typed (`find . -path
 * ./skip` prints and matches `./skip`), so `bindTree` stamps all three
 * onto the node before evaluation and entry keys stay mount-relative
 * (#396). An empty `root` leaves the row as the display path. `icase` is
 * `-ipath`.
 */
export interface Path {
  op: 'path'
  pattern: string
  prefix?: string
  root?: string
  raw?: string
  icase?: boolean
}

/**
 * `-regex` and `-iregex`: an expression that must match the whole path
 * as `find` prints it, spelled as `Path` spells it from the same three
 * fields `bindTree` stamps. Evaluation is synchronous and a search is
 * not, so the walk asks every entry's answer before it evaluates
 * (`primeRegexes`) and the node keeps them by entry key.
 */
export interface Regex {
  op: 'regex'
  pattern: string
  icase: boolean
  dialect: 'emacs' | 'posix'
  extended: boolean
  utf8: boolean
  prefix?: string
  root?: string
  raw?: string
  hits: Map<string, boolean>
}

/** `-lname` and `-ilname`: a glob over a link's target text. */
export interface Lname {
  op: 'lname'
  pattern: string
  icase: boolean
}

export interface Type {
  op: 'type'
  kind: string
}

/** `-xtype`: the entry's kind on the other side of a link. */
export interface XType {
  op: 'xtype'
  kind: string
}

/**
 * `-perm`: the entry's permission bits against `mode`, exactly, with
 * every bit of it set (`all`) or with any (`any`, which an empty mode
 * always holds for).
 */
export interface Perm {
  op: 'perm'
  mode: number
  bits: 'exact' | 'all' | 'any'
}

/** `-links`, `-uid` and `-gid`: a number compared with `count`. */
export interface Count {
  op: 'count'
  field: 'links' | 'uid' | 'gid'
  cmp: '+' | '-' | '='
  count: number
}

/**
 * `-user` and `-group`: the owner or group as `ls -l` names it. mirage
 * keeps any name `chown` was given, so every name is a user and none is
 * refused; a number also matches the id it spells. `profile` is the
 * session's own name, which owns an entry that reports none.
 */
export interface Owner {
  op: 'owner'
  name: string
  group: boolean
  profile: string | null
}

/**
 * `-nouser` and `-nogroup`: an owner or group known only by its number.
 * mirage keeps no user database, so a number names no one, as `ls -l`
 * shows it; a name `chown` stored, or the session owning an entry that
 * reports none, is someone.
 */
export interface NoOwner {
  op: 'nouser'
  group: boolean
}

/**
 * `-readable`, `-writable` and `-executable`: the owner's bits of the
 * entry's mode, the session owning what it sees.
 */
export interface Access {
  op: 'access'
  mode: 'r' | 'w' | 'x'
}

/**
 * `-quit`: true, and nothing after it runs, for this entry or any other.
 * The walk reads `fired` after each entry to stop.
 */
export interface Quit {
  op: 'quit'
  fired: string[]
}

// -size as the inclusive byte bounds it rounds to; a directory weighs
// DIR_SIZE, a stat of unknown size nothing, and an entry with no stat matches
// no bound.
export interface Size {
  op: 'size'
  min: number | null
  max: number | null
}

export interface Empty {
  op: 'empty'
}

export interface Not {
  op: 'not'
  kid: PredNode
}

export interface And {
  op: 'and'
  kids: PredNode[]
}

export interface Or {
  op: 'or'
  kids: PredNode[]
}

export interface TrueNode {
  op: 'true'
}

/**
 * An action the expression reached (-print, -print0, -ls, -delete,
 * -exec, -printf): true, like GNU's, and it marks the entry as acted on.
 * A tree that holds one keeps the entries an action reached rather than
 * the ones the whole expression held for, which is how `-o`
 * short-circuits past a `-print` (`-path ./skip -prune -o -type f
 * -print` never reaches the print for `./skip`). The executor still runs
 * the action itself, once per kept row, so the parser admits one
 * distinct action to a tree holding any. GNU's `-exec ... ;` alone is
 * false when its command fails, which the executor learns only after the
 * walk, so the parser lets it stand only where nothing follows it;
 * `batch` marks `-exec ... {} +`, true whatever the command exits.
 */
export interface Action {
  op: 'action'
  kind: ActionKind
  batch?: boolean
}

/**
 * `-prune`: true, and a directory it reaches loses its contents. Every
 * backend evaluates the tree entry by entry with no say over its own
 * walk, and a flat listing meets a child before its parent, so the node
 * keeps the ledger of pruned directory keys (mount-relative) and
 * `dropPruned` applies it to what the walk returned; `bindTree` hands
 * every start point a fresh ledger. A prune reached past a time test the
 * entry could not answer lands in `pending`; until `settlePrunes`
 * evaluates the directory again with its mtime, it counts as pruned, the
 * most a walk without times can say.
 */
export interface Prune {
  op: 'prune'
  pruned: string[]
  pending: PendingPrune[]
}

export type PredNode =
  | Name
  | Path
  | Regex
  | Lname
  | Type
  | XType
  | Perm
  | Count
  | Owner
  | NoOwner
  | Access
  | Size
  | Empty
  | Not
  | And
  | Or
  | TrueNode
  | Action
  | Prune
  | Quit
  | Mtime

// What evaluating an expression on one entry did besides answer: whether an
// action was reached, whether a prune node recorded the entry (firm or
// pending), whether a -quit ended the evaluation, and the time tests the
// entry carried no mtime for on the path that decided the answer so far; a
// branch whose outcome they could not have changed drops them again.
export interface Effects {
  acted: boolean
  pruned: boolean
  quit?: boolean
  deferred: Mtime[]
}

export interface EmitStartPathOptions {
  kind: FindEntry['kind']
  isEmpty?: boolean | null
  exists: boolean
  tree: PredNode
  maxDepth: number | null | undefined
  minDepth: number | null | undefined
  size?: number | null | undefined
  minSize?: number | null | undefined
  maxSize?: number | null | undefined
  // Epoch-second mtime for the tree's time tests; null when unknown.
  mtime?: number | null | undefined
  // The start path's stat, for the tests that read one.
  stat?: FileStat | null | undefined
}

export interface BuildTreeOptions {
  name?: string | null | undefined
  iname?: string | null | undefined
  pathPattern?: string | null | undefined
  type?: string | null | undefined
  nameExclude?: string | null | undefined
  orNames?: string[] | null | undefined
  empty?: boolean | null | undefined
}
