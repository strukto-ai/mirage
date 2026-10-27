// Adapted from jq 1.8.2 (MIT), src/lexer.l, src/parser.y and src/locfile.c. See licenses/third_party/jq.txt.

use std::collections::HashMap;
use std::sync::OnceLock;

use super::builtin::{self, Fault};
use super::lalr::{self, Action, Assoc, Tables};
use super::parse::parse_value;
use super::value::{Number, Object, Value};
use super::vm::Limits;

/// How deep the tree of a program may nest before jq_eval leaves it to
/// libjq: checking, compiling and dropping it recurse.
const DEPTH: usize = 512;

/// Bison's YYMAXDEPTH: the parser stack jq's parser grows up to.
const STACK: usize = 10000;

const TOKENS: [&str; 70] = [
    "\"end of file\"",
    "error",
    "\"invalid token\"",
    "INVALID_CHARACTER",
    "IDENT",
    "FIELD",
    "BINDING",
    "LITERAL",
    "FORMAT",
    "\"..\"",
    "\"%=\"",
    "\"==\"",
    "\"!=\"",
    "\"//\"",
    "\"as\"",
    "\"def\"",
    "\"module\"",
    "\"import\"",
    "\"include\"",
    "\"if\"",
    "\"then\"",
    "\"else\"",
    "\"elif\"",
    "\"reduce\"",
    "\"foreach\"",
    "\"end\"",
    "\"and\"",
    "\"or\"",
    "\"try\"",
    "\"catch\"",
    "\"label\"",
    "\"break\"",
    "\"$__loc__\"",
    "\"|=\"",
    "\"+=\"",
    "\"-=\"",
    "\"*=\"",
    "\"/=\"",
    "\"//=\"",
    "\"<=\"",
    "\">=\"",
    "\"?//\"",
    "QQSTRING_START",
    "QQSTRING_TEXT",
    "QQSTRING_INTERP_START",
    "QQSTRING_INTERP_END",
    "QQSTRING_END",
    "FUNCDEF",
    "'|'",
    "','",
    "'='",
    "'<'",
    "'>'",
    "'+'",
    "'-'",
    "'*'",
    "'/'",
    "'%'",
    "NONOPT",
    "'?'",
    "'.'",
    "'['",
    "';'",
    "':'",
    "'('",
    "')'",
    "']'",
    "'{'",
    "'}'",
    "'$'",
];

const END: usize = 0;
const ERROR: usize = 1;
const INVALID: usize = 3;
const IDENT: usize = 4;
const FIELD: usize = 5;
const BINDING: usize = 6;
const LITERAL: usize = 7;
const FORMAT: usize = 8;
const REC: usize = 9;
const LOC: usize = 32;
const QQSTRING_START: usize = 42;
const QQSTRING_TEXT: usize = 43;
const QQSTRING_INTERP_START: usize = 44;
const QQSTRING_INTERP_END: usize = 45;
const QQSTRING_END: usize = 46;
const LBRACKET: usize = 61;
const LPAREN: usize = 64;
const RPAREN: usize = 65;
const RBRACKET: usize = 66;
const LBRACE: usize = 67;
const RBRACE: usize = 68;

const PRECEDENCE: &[(Assoc, &[&str])] = &[
    (Assoc::Precedence, &["FUNCDEF"]),
    (Assoc::Right, &["'|'"]),
    (Assoc::Left, &["','"]),
    (Assoc::Right, &["\"//\""]),
    (
        Assoc::Nonassoc,
        &[
            "'='", "\"|=\"", "\"+=\"", "\"-=\"", "\"*=\"", "\"/=\"", "\"%=\"", "\"//=\"",
        ],
    ),
    (Assoc::Left, &["\"or\""]),
    (Assoc::Left, &["\"and\""]),
    (
        Assoc::Nonassoc,
        &["\"!=\"", "\"==\"", "'<'", "'>'", "\"<=\"", "\">=\""],
    ),
    (Assoc::Left, &["'+'", "'-'"]),
    (Assoc::Left, &["'*'", "'/'", "'%'"]),
    (Assoc::Precedence, &["NONOPT"]),
    (Assoc::Precedence, &["'?'", "'.'", "'['", "FIELD"]),
    (Assoc::Precedence, &["\"try\""]),
    (Assoc::Precedence, &["\"catch\""]),
];

const BREAK_LABEL: &str = "break requires a label to break to";
const FIELD_NAME: &str = "try .[\"field\"] instead of .field for unusually named fields";
const UNTERMINATED_IF: &str = "Possibly unterminated 'if' statement";
const UNTERMINATED_TRY: &str = "Possibly unterminated 'try' statement";
const PARENS: &str = "May need parentheses around object key expression";

#[derive(Clone, Copy)]
enum Act {
    TopQuery,
    TopDefs,
    Nothing,
    Module,
    ImportMeta,
    ImportFrom,
    Empty,
    One,
    Append,
    Prepend,
    Pass,
    Take(usize),
    DefIn,
    Bind,
    Label,
    Pipe,
    Comma,
    Alternative,
    Or,
    And,
    Update(Update),
    Binop(BinOp),
    FuncDef,
    FuncDefParams,
    Param(bool),
    TextFormat,
    QqEmpty,
    QqText,
    QqInterp,
    Elif,
    Else,
    End,
    Identity,
    Recurse,
    Break,
    Fail(&'static str, Option<usize>),
    Index(bool, usize, bool),
    Each(bool),
    Slice(Option<usize>, Option<usize>, bool),
    Optional,
    Literal,
    Format,
    Neg,
    Collect,
    EmptyArray,
    Object,
    Reduce,
    Foreach(bool),
    If,
    TryCatch,
    Try,
    LoadVn,
    Var,
    Loc,
    Ident,
    Call,
    PatVar,
    PatArray,
    PatObject,
    ObjPatVar,
    ObjPatVarSub,
    ObjPatKey,
    ObjPatExpr,
    ObjPatError,
    Keyword(&'static str),
    Pair,
    PairString,
    PairVar,
    PairVarShort,
    PairField,
    PairLoc,
    PairExpr,
    PairError,
}

/// jq 1.8.2's grammar, rule for rule in parser.y's order, which Bison's
/// tie-breaks depend on.
const RULES: &[(&str, Act)] = &[
    ("TopLevel: Module Imports Query", Act::TopQuery),
    ("TopLevel: Module Imports FuncDefs", Act::TopDefs),
    ("Module:", Act::Nothing),
    ("Module: \"module\" Query ';'", Act::Module),
    ("Imports:", Act::Nothing),
    ("Imports: Import Imports", Act::Nothing),
    ("FuncDefs:", Act::Empty),
    ("FuncDefs: FuncDef FuncDefs", Act::Prepend),
    ("Query: FuncDef Query %prec FUNCDEF", Act::DefIn),
    ("Query: Expr \"as\" Patterns '|' Query", Act::Bind),
    ("Query: \"label\" BINDING '|' Query", Act::Label),
    ("Query: Query '|' Query", Act::Pipe),
    ("Query: Query ',' Query", Act::Comma),
    ("Query: Expr", Act::Pass),
    ("Expr: Expr \"//\" Expr", Act::Alternative),
    ("Expr: Expr '=' Expr", Act::Update(Update::Assign)),
    ("Expr: Expr \"or\" Expr", Act::Or),
    ("Expr: Expr \"and\" Expr", Act::And),
    ("Expr: Expr \"//=\" Expr", Act::Update(Update::Alternative)),
    ("Expr: Expr \"|=\" Expr", Act::Update(Update::Modify)),
    ("Expr: Expr '+' Expr", Act::Binop(BinOp::Plus)),
    (
        "Expr: Expr \"+=\" Expr",
        Act::Update(Update::Arith(BinOp::Plus)),
    ),
    ("Expr: Expr '-' Expr", Act::Binop(BinOp::Minus)),
    (
        "Expr: Expr \"-=\" Expr",
        Act::Update(Update::Arith(BinOp::Minus)),
    ),
    ("Expr: Expr '*' Expr", Act::Binop(BinOp::Multiply)),
    (
        "Expr: Expr \"*=\" Expr",
        Act::Update(Update::Arith(BinOp::Multiply)),
    ),
    ("Expr: Expr '/' Expr", Act::Binop(BinOp::Divide)),
    ("Expr: Expr '%' Expr", Act::Binop(BinOp::Mod)),
    (
        "Expr: Expr \"/=\" Expr",
        Act::Update(Update::Arith(BinOp::Divide)),
    ),
    (
        "Expr: Expr \"%=\" Expr",
        Act::Update(Update::Arith(BinOp::Mod)),
    ),
    ("Expr: Expr \"==\" Expr", Act::Binop(BinOp::Equal)),
    ("Expr: Expr \"!=\" Expr", Act::Binop(BinOp::NotEqual)),
    ("Expr: Expr '<' Expr", Act::Binop(BinOp::Less)),
    ("Expr: Expr '>' Expr", Act::Binop(BinOp::Greater)),
    ("Expr: Expr \"<=\" Expr", Act::Binop(BinOp::LessEq)),
    ("Expr: Expr \">=\" Expr", Act::Binop(BinOp::GreaterEq)),
    ("Expr: Term %prec NONOPT", Act::Pass),
    ("Import: ImportWhat ';'", Act::Nothing),
    ("Import: ImportWhat Query ';'", Act::ImportMeta),
    (
        "ImportWhat: \"import\" ImportFrom \"as\" BINDING",
        Act::Nothing,
    ),
    (
        "ImportWhat: \"import\" ImportFrom \"as\" IDENT",
        Act::Nothing,
    ),
    ("ImportWhat: \"include\" ImportFrom", Act::Nothing),
    ("ImportFrom: String", Act::ImportFrom),
    ("FuncDef: \"def\" IDENT ':' Query ';'", Act::FuncDef),
    (
        "FuncDef: \"def\" IDENT '(' Params ')' ':' Query ';'",
        Act::FuncDefParams,
    ),
    ("Params: Param", Act::One),
    ("Params: Params ';' Param", Act::Append),
    ("Param: BINDING", Act::Param(true)),
    ("Param: IDENT", Act::Param(false)),
    ("StringStart: FORMAT QQSTRING_START", Act::Pass),
    ("StringStart: QQSTRING_START", Act::TextFormat),
    ("String: StringStart QQString QQSTRING_END", Act::Take(1)),
    ("QQString:", Act::QqEmpty),
    ("QQString: QQString QQSTRING_TEXT", Act::QqText),
    (
        "QQString: QQString QQSTRING_INTERP_START Query QQSTRING_INTERP_END",
        Act::QqInterp,
    ),
    (
        "ElseBody: \"elif\" Query \"then\" Query ElseBody",
        Act::Elif,
    ),
    ("ElseBody: \"else\" Query \"end\"", Act::Else),
    ("ElseBody: \"end\"", Act::End),
    ("Term: '.'", Act::Identity),
    ("Term: \"..\"", Act::Recurse),
    ("Term: \"break\" BINDING", Act::Break),
    ("Term: \"break\" error", Act::Fail(BREAK_LABEL, None)),
    ("Term: Term FIELD '?'", Act::Index(true, 1, true)),
    ("Term: FIELD '?'", Act::Index(false, 0, true)),
    ("Term: Term '.' String '?'", Act::Index(true, 2, true)),
    ("Term: '.' String '?'", Act::Index(false, 1, true)),
    ("Term: Term FIELD %prec NONOPT", Act::Index(true, 1, false)),
    ("Term: FIELD %prec NONOPT", Act::Index(false, 0, false)),
    (
        "Term: Term '.' String %prec NONOPT",
        Act::Index(true, 2, false),
    ),
    ("Term: '.' String %prec NONOPT", Act::Index(false, 1, false)),
    ("Term: '.' error", Act::Fail(FIELD_NAME, None)),
    ("Term: '.' IDENT error", Act::Fail(FIELD_NAME, None)),
    ("Term: Term '[' Query ']' '?'", Act::Index(true, 2, true)),
    (
        "Term: Term '[' Query ']' %prec NONOPT",
        Act::Index(true, 2, false),
    ),
    (
        "Term: Term '.' '[' Query ']' '?'",
        Act::Index(true, 3, true),
    ),
    (
        "Term: Term '.' '[' Query ']' %prec NONOPT",
        Act::Index(true, 3, false),
    ),
    ("Term: Term '[' ']' '?'", Act::Each(true)),
    ("Term: Term '[' ']' %prec NONOPT", Act::Each(false)),
    ("Term: Term '.' '[' ']' '?'", Act::Each(true)),
    ("Term: Term '.' '[' ']' %prec NONOPT", Act::Each(false)),
    (
        "Term: Term '[' Query ':' Query ']' '?'",
        Act::Slice(Some(2), Some(4), true),
    ),
    (
        "Term: Term '[' Query ':' ']' '?'",
        Act::Slice(Some(2), None, true),
    ),
    (
        "Term: Term '[' ':' Query ']' '?'",
        Act::Slice(None, Some(3), true),
    ),
    (
        "Term: Term '[' Query ':' Query ']' %prec NONOPT",
        Act::Slice(Some(2), Some(4), false),
    ),
    (
        "Term: Term '[' Query ':' ']' %prec NONOPT",
        Act::Slice(Some(2), None, false),
    ),
    (
        "Term: Term '[' ':' Query ']' %prec NONOPT",
        Act::Slice(None, Some(3), false),
    ),
    ("Term: Term '?'", Act::Optional),
    ("Term: LITERAL", Act::Literal),
    ("Term: String", Act::Pass),
    ("Term: FORMAT", Act::Format),
    ("Term: '-' Term", Act::Neg),
    ("Term: '(' Query ')'", Act::Take(1)),
    ("Term: '[' Query ']'", Act::Collect),
    ("Term: '[' ']'", Act::EmptyArray),
    ("Term: '{' DictPairs '}'", Act::Object),
    (
        "Term: \"reduce\" Expr \"as\" Patterns '(' Query ';' Query ')'",
        Act::Reduce,
    ),
    (
        "Term: \"foreach\" Expr \"as\" Patterns '(' Query ';' Query ';' Query ')'",
        Act::Foreach(true),
    ),
    (
        "Term: \"foreach\" Expr \"as\" Patterns '(' Query ';' Query ')'",
        Act::Foreach(false),
    ),
    ("Term: \"if\" Query \"then\" Query ElseBody", Act::If),
    (
        "Term: \"if\" Query \"then\" error",
        Act::Fail(UNTERMINATED_IF, Some(1)),
    ),
    ("Term: \"try\" Expr \"catch\" Expr", Act::TryCatch),
    (
        "Term: \"try\" Expr \"catch\" error",
        Act::Fail(UNTERMINATED_TRY, Some(1)),
    ),
    ("Term: \"try\" Expr", Act::Try),
    ("Term: '$' '$' '$' BINDING", Act::LoadVn),
    ("Term: BINDING", Act::Var),
    ("Term: \"$__loc__\"", Act::Loc),
    ("Term: IDENT", Act::Ident),
    ("Term: IDENT '(' Args ')'", Act::Call),
    ("Term: '(' error ')'", Act::Identity),
    ("Term: '[' error ']'", Act::Identity),
    ("Term: Term '[' error ']'", Act::Take(0)),
    ("Term: '{' error '}'", Act::Identity),
    ("Args: Arg", Act::One),
    ("Args: Args ';' Arg", Act::Append),
    ("Arg: Query", Act::Pass),
    ("RepPatterns: RepPatterns \"?//\" Pattern", Act::Append),
    ("RepPatterns: Pattern", Act::One),
    ("Patterns: RepPatterns \"?//\" Pattern", Act::Append),
    ("Patterns: Pattern", Act::One),
    ("Pattern: BINDING", Act::PatVar),
    ("Pattern: '[' ArrayPats ']'", Act::PatArray),
    ("Pattern: '{' ObjPats '}'", Act::PatObject),
    ("ArrayPats: Pattern", Act::One),
    ("ArrayPats: ArrayPats ',' Pattern", Act::Append),
    ("ObjPats: ObjPat", Act::One),
    ("ObjPats: ObjPats ',' ObjPat", Act::Append),
    ("ObjPat: BINDING", Act::ObjPatVar),
    ("ObjPat: BINDING ':' Pattern", Act::ObjPatVarSub),
    ("ObjPat: IDENT ':' Pattern", Act::ObjPatKey),
    ("ObjPat: Keyword ':' Pattern", Act::ObjPatKey),
    ("ObjPat: String ':' Pattern", Act::ObjPatKey),
    ("ObjPat: '(' Query ')' ':' Pattern", Act::ObjPatExpr),
    ("ObjPat: error ':' Pattern", Act::ObjPatError),
    ("Keyword: \"as\"", Act::Keyword("as")),
    ("Keyword: \"def\"", Act::Keyword("def")),
    ("Keyword: \"module\"", Act::Keyword("module")),
    ("Keyword: \"import\"", Act::Keyword("import")),
    ("Keyword: \"include\"", Act::Keyword("include")),
    ("Keyword: \"if\"", Act::Keyword("if")),
    ("Keyword: \"then\"", Act::Keyword("then")),
    ("Keyword: \"else\"", Act::Keyword("else")),
    ("Keyword: \"elif\"", Act::Keyword("elif")),
    ("Keyword: \"reduce\"", Act::Keyword("reduce")),
    ("Keyword: \"foreach\"", Act::Keyword("foreach")),
    ("Keyword: \"end\"", Act::Keyword("end")),
    ("Keyword: \"and\"", Act::Keyword("and")),
    ("Keyword: \"or\"", Act::Keyword("or")),
    ("Keyword: \"try\"", Act::Keyword("try")),
    ("Keyword: \"catch\"", Act::Keyword("catch")),
    ("Keyword: \"label\"", Act::Keyword("label")),
    ("Keyword: \"break\"", Act::Keyword("break")),
    ("DictPairs:", Act::Empty),
    ("DictPairs: DictPair", Act::One),
    ("DictPairs: DictPair ',' DictPairs", Act::Prepend),
    ("DictPair: IDENT ':' DictExpr", Act::Pair),
    ("DictPair: Keyword ':' DictExpr", Act::Pair),
    ("DictPair: String ':' DictExpr", Act::Pair),
    ("DictPair: String", Act::PairString),
    ("DictPair: BINDING ':' DictExpr", Act::PairVar),
    ("DictPair: BINDING", Act::PairVarShort),
    ("DictPair: IDENT", Act::PairField),
    ("DictPair: \"$__loc__\"", Act::PairLoc),
    ("DictPair: Keyword", Act::PairField),
    ("DictPair: '(' Query ')' ':' DictExpr", Act::PairExpr),
    ("DictPair: error ':' DictExpr", Act::PairError),
    ("DictExpr: DictExpr '|' DictExpr", Act::Pipe),
    ("DictExpr: Expr", Act::Pass),
];

struct Grammar {
    tables: Tables,
    lexemes: HashMap<&'static str, usize>,
}

fn grammar() -> &'static Grammar {
    static GRAMMAR: OnceLock<Grammar> = OnceLock::new();
    GRAMMAR.get_or_init(|| {
        let rules: Vec<&str> = RULES.iter().map(|(text, _)| *text).collect();
        let tables = lalr::build(&TOKENS, PRECEDENCE, &rules);
        assert_eq!(tables.conflicts, 0, "jq's grammar expects no conflict");
        let lexemes = TOKENS
            .iter()
            .enumerate()
            .filter_map(|(id, name)| {
                let inner = name
                    .strip_prefix('"')
                    .and_then(|n| n.strip_suffix('"'))
                    .or_else(|| name.strip_prefix('\'').and_then(|n| n.strip_suffix('\'')))?;
                Some((inner, id))
            })
            .collect();
        Grammar { tables, lexemes }
    })
}

/// A span of the program in bytes, as jq's lexer locates each token.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Loc {
    pub(crate) start: usize,
    pub(crate) end: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum BinOp {
    Plus,
    Minus,
    Multiply,
    Divide,
    Mod,
    Equal,
    NotEqual,
    Less,
    LessEq,
    Greater,
    GreaterEq,
}

impl BinOp {
    pub(crate) fn function(self) -> &'static str {
        match self {
            Self::Plus => "_plus",
            Self::Minus => "_minus",
            Self::Multiply => "_multiply",
            Self::Divide => "_divide",
            Self::Mod => "_mod",
            Self::Equal => "_equal",
            Self::NotEqual => "_notequal",
            Self::Less => "_less",
            Self::LessEq => "_lesseq",
            Self::Greater => "_greater",
            Self::GreaterEq => "_greatereq",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Update {
    Assign,
    Modify,
    Arith(BinOp),
    Alternative,
}

#[derive(Clone, Debug)]
pub(crate) enum Ast {
    Identity,
    Recurse,
    Literal(Value),
    Format(String),
    Index(Box<Ast>, Box<Ast>, bool),
    Slice(Box<Ast>, Option<Box<Ast>>, Option<Box<Ast>>, bool),
    Each(Box<Ast>, bool),
    Try(Box<Ast>, Option<Box<Ast>>),
    Neg(Box<Ast>),
    Pipe(Box<Ast>, Box<Ast>),
    Comma(Box<Ast>, Box<Ast>),
    Binop(BinOp, Box<Ast>, Box<Ast>),
    And(Box<Ast>, Box<Ast>),
    Or(Box<Ast>, Box<Ast>),
    Alternative(Box<Ast>, Box<Ast>),
    Update(Update, Box<Ast>, Box<Ast>),
    If(Box<Ast>, Box<Ast>, Option<Box<Ast>>),
    Reduce(Box<Ast>, Vec<Pattern>, Box<Ast>, Box<Ast>),
    Foreach(Box<Ast>, Vec<Pattern>, Box<Ast>, Box<Ast>, Option<Box<Ast>>),
    Bind(Box<Ast>, Vec<Pattern>, Box<Ast>),
    Label(String, Box<Ast>),
    Break(String, Loc),
    Def(Box<Def>, Box<Ast>),
    Call(String, Vec<Ast>, Loc),
    Var(String, Loc),
    Collect(Option<Box<Ast>>),
    Object(Vec<(Ast, Ast)>),
}

#[derive(Clone, Debug)]
pub(crate) enum Pattern {
    Var(String),
    Array(Vec<Pattern>),
    Object(Vec<(PatternKey, Option<Pattern>)>),
}

#[derive(Clone, Debug)]
pub(crate) enum PatternKey {
    Var(String),
    Expr(Ast),
}

#[derive(Clone, Debug)]
pub(crate) struct Def {
    pub(crate) name: String,
    pub(crate) params: Vec<(String, bool)>,
    pub(crate) body: Ast,
}

/// What jq's parser makes of a program.
pub(crate) enum Parsed {
    /// The program's main query.
    Program(Ast),
    /// jq refuses it: each message as jq reports it.
    Invalid(Vec<String>),
    /// Valid, but uses what jq_eval leaves to libjq.
    Unsupported(&'static str),
}

/// Parse a whole program, as jq_compile_args parses its text.
pub(crate) fn parse(source: &str) -> Parsed {
    let mut parser = Parser::new(source);
    let top = parser.run();
    if let Some(why) = parser.unworded {
        return Parsed::Unsupported(why);
    }
    if !parser.errors.is_empty() {
        return Parsed::Invalid(parser.errors);
    }
    match top {
        Some(Sem::Ast(ast)) => {
            if let Some(why) = parser.unsupported {
                return Parsed::Unsupported(why);
            }
            Parsed::Program(ast)
        }
        _ => Parsed::Invalid(vec![
            "jq: error: Top-level program not given (try \".\")".into(),
        ]),
    }
}

/// Parse a library of definitions, as jq reads builtin.jq.
pub(crate) fn parse_defs(source: &str) -> Result<Vec<Def>, String> {
    let mut parser = Parser::new(source);
    let top = parser.run();
    if !parser.errors.is_empty() {
        return Err(parser.errors.join("\n"));
    }
    match top {
        Some(Sem::List(defs)) => Ok(defs
            .into_iter()
            .filter_map(|d| match d {
                Sem::Def(def) => Some(def),
                _ => None,
            })
            .collect()),
        _ => Err("library should only have function definitions, not a main expression".into()),
    }
}

/// jq's report of a program it refuses: each message, then the count.
pub(crate) fn report(messages: &[String]) -> String {
    let n = messages.len();
    let noun = if n > 1 { "errors" } else { "error" };
    format!("{}\njq: {n} compile {noun}", messages.join("\n"))
}

/// locfile_locate: `jq: error: message`, where in the program, the line it
/// starts on, and a caret under the span as far as that line goes.
pub(crate) fn locate(source: &str, loc: Loc, message: &str) -> String {
    let src = source.as_bytes();
    let start = loc.start.min(src.len().saturating_sub(1));
    let offset = src[..start]
        .iter()
        .rposition(|b| *b == b'\n')
        .map_or(0, |at| at + 1);
    let line = src[..start].iter().filter(|b| **b == b'\n').count() + 1;
    let line_end = src[start..]
        .iter()
        .position(|b| *b == b'\n')
        .map_or(src.len(), |at| start + at);
    let end = loc.end.min(line_end.max(start + 1)).max(start);
    format!(
        "jq: error: {message} at <top-level>, line {line}, column {}:\n    {}\n    {}{}",
        start - offset + 1,
        String::from_utf8_lossy(&src[offset..line_end]),
        " ".repeat(start - offset),
        "^".repeat(end - start),
    )
}

#[derive(Clone, Copy, PartialEq)]
enum Cond {
    Initial,
    Paren,
    Bracket,
    Brace,
    Interp,
    String,
    Comment,
}

/// lexer.l: tokens with their spans, the start-condition stack its
/// brackets and strings push, and the span of the last lexeme matched,
/// which is where the end of the file is reported.
struct Lexer<'a> {
    src: &'a [u8],
    at: usize,
    cond: Cond,
    stack: Vec<Cond>,
    last: Loc,
}

fn ident_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

fn ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_'
}

impl Lexer<'_> {
    fn byte(&self, at: usize) -> Option<u8> {
        self.src.get(at).copied()
    }

    fn take(&mut self, len: usize) -> Loc {
        self.last = Loc {
            start: self.at,
            end: self.at + len,
        };
        self.at += len;
        self.last
    }

    fn push(&mut self, cond: Cond) {
        self.stack.push(self.cond);
        self.cond = cond;
    }

    fn pop(&mut self) {
        self.cond = self.stack.pop().unwrap_or(Cond::Initial);
    }

    fn text(&self, loc: Loc) -> String {
        String::from_utf8_lossy(&self.src[loc.start..loc.end]).into_owned()
    }

    /// `([a-zA-Z_][a-zA-Z_0-9]*::)*[a-zA-Z_][a-zA-Z_0-9]*` from `at`.
    fn name_end(&self, mut at: usize) -> usize {
        loop {
            while self.byte(at).is_some_and(ident_char) {
                at += 1;
            }
            if self.src[at..].starts_with(b"::") && self.byte(at + 2).is_some_and(ident_start) {
                at += 2;
                continue;
            }
            return at;
        }
    }

    fn number_end(&self) -> usize {
        let mut at = self.at;
        while self.byte(at).is_some_and(|c| c.is_ascii_digit()) {
            at += 1;
        }
        if self.byte(at) == Some(b'.') {
            at += 1;
            while self.byte(at).is_some_and(|c| c.is_ascii_digit()) {
                at += 1;
            }
        }
        if matches!(self.byte(at), Some(b'e' | b'E')) {
            let mut exp = at + 1;
            if matches!(self.byte(exp), Some(b'+' | b'-')) {
                exp += 1;
            }
            if self.byte(exp).is_some_and(|c| c.is_ascii_digit()) {
                while self.byte(exp).is_some_and(|c| c.is_ascii_digit()) {
                    exp += 1;
                }
                at = exp;
            }
        }
        at
    }

    fn exit(&mut self, close: u8) -> usize {
        let (want, token) = match self.cond {
            Cond::Paren => (b')', RPAREN),
            Cond::Bracket => (b']', RBRACKET),
            Cond::Brace => (b'}', RBRACE),
            Cond::Interp => (b')', QQSTRING_INTERP_END),
            _ => return INVALID,
        };
        if want == close {
            self.pop();
            token
        } else {
            INVALID
        }
    }

    /// The next token: its id, its value, and its span.
    fn next(&mut self, lexemes: &HashMap<&'static str, usize>) -> (usize, Sem) {
        loop {
            let Some(c) = self.byte(self.at) else {
                if self.cond == Cond::Comment {
                    self.pop();
                    continue;
                }
                return (END, Sem::None);
            };
            let next = self.byte(self.at + 1);
            match self.cond {
                Cond::Comment => {
                    let len = match (c, next, self.byte(self.at + 2)) {
                        (b'\\', Some(b'\\' | b'\n'), _) => 2,
                        (b'\\', Some(b'\r'), Some(b'\n')) => 3,
                        (b'\r', Some(b'\n'), _) => {
                            self.pop();
                            2
                        }
                        (b'\n', _, _) => {
                            self.pop();
                            1
                        }
                        _ => 1,
                    };
                    self.take(len);
                    continue;
                }
                Cond::String => return self.string_token(c, next),
                _ => {}
            }
            if c == b'#' {
                self.take(1);
                self.push(Cond::Comment);
                continue;
            }
            if matches!(c, b' ' | b'\t' | b'\r' | b'\n') {
                let mut len = 1;
                while matches!(self.byte(self.at + len), Some(b' ' | b'\t' | b'\r' | b'\n')) {
                    len += 1;
                }
                self.take(len);
                continue;
            }
            if ident_start(c) {
                let loc = self.take(self.name_end(self.at) - self.at);
                let text = self.text(loc);
                if let Some(&id) = lexemes.get(text.as_str()) {
                    return (id, Sem::None);
                }
                return (IDENT, Sem::Text(text));
            }
            if c == b'$' && next.is_some_and(ident_start) {
                let loc = self.take(self.name_end(self.at + 1) - self.at);
                let text = self.text(loc);
                if text == "$__loc__" {
                    return (LOC, Sem::None);
                }
                return (BINDING, Sem::Text(text[1..].to_string()));
            }
            if c == b'.' {
                match next {
                    Some(b'.') => {
                        self.take(2);
                        return (REC, Sem::None);
                    }
                    Some(n) if ident_start(n) => {
                        let mut end = self.at + 1;
                        while self.byte(end).is_some_and(ident_char) {
                            end += 1;
                        }
                        let loc = self.take(end - self.at);
                        let text = self.text(Loc {
                            start: loc.start + 1,
                            end,
                        });
                        return (FIELD, Sem::Text(text));
                    }
                    Some(n) if n.is_ascii_digit() => return self.number(),
                    _ => {}
                }
            }
            if c.is_ascii_digit() {
                return self.number();
            }
            if c == b'@' && next.is_some_and(ident_char) {
                let mut end = self.at + 1;
                while self.byte(end).is_some_and(ident_char) {
                    end += 1;
                }
                let loc = self.take(end - self.at);
                return (
                    FORMAT,
                    Sem::Text(self.text(Loc {
                        start: loc.start + 1,
                        end,
                    })),
                );
            }
            match c {
                b'"' => {
                    self.take(1);
                    self.push(Cond::String);
                    return (QQSTRING_START, Sem::None);
                }
                b'(' | b'[' | b'{' => {
                    self.take(1);
                    let (cond, token) = match c {
                        b'(' => (Cond::Paren, LPAREN),
                        b'[' => (Cond::Bracket, LBRACKET),
                        _ => (Cond::Brace, LBRACE),
                    };
                    self.push(cond);
                    return (token, Sem::None);
                }
                b')' | b']' | b'}' => {
                    self.take(1);
                    return (self.exit(c), Sem::None);
                }
                _ => {}
            }
            for len in [3, 2, 1] {
                let Some(text) = self.src.get(self.at..self.at + len) else {
                    continue;
                };
                let Ok(text) = std::str::from_utf8(text) else {
                    continue;
                };
                if let Some(&id) = lexemes.get(text) {
                    if text.bytes().all(|b| !ident_char(b) && b != b'"') {
                        self.take(len);
                        return (id, Sem::None);
                    }
                }
            }
            self.take(1);
            return (INVALID, Sem::None);
        }
    }

    fn number(&mut self) -> (usize, Sem) {
        let loc = self.take(self.number_end() - self.at);
        let text = self.text(loc);
        let text = match text.strip_prefix('.') {
            Some(rest) => format!("0.{rest}"),
            None => text,
        };
        (LITERAL, Sem::Lit(Ok(Value::Number(Number::literal(&text)))))
    }

    fn string_token(&mut self, c: u8, next: Option<u8>) -> (usize, Sem) {
        match (c, next) {
            (b'\\', Some(b'(')) => {
                self.take(2);
                self.push(Cond::Interp);
                (QQSTRING_INTERP_START, Sem::None)
            }
            (b'"', _) => {
                self.take(1);
                self.pop();
                (QQSTRING_END, Sem::None)
            }
            (b'\\', Some(_)) => {
                let mut end = self.at;
                while self.byte(end) == Some(b'\\') {
                    match self.byte(end + 1) {
                        Some(b'u') => {
                            end += 2;
                            let mut n = 0;
                            while n < 4 && self.byte(end).is_some_and(|b| b.is_ascii_alphanumeric())
                            {
                                end += 1;
                                n += 1;
                            }
                        }
                        Some(b'(') | None => break,
                        Some(_) => end += 2,
                    }
                }
                let loc = self.take(end - self.at);
                let mut quoted = Vec::with_capacity(end - loc.start + 2);
                quoted.push(b'"');
                quoted.extend_from_slice(&self.src[loc.start..end]);
                quoted.push(b'"');
                (QQSTRING_TEXT, Sem::Lit(parse_value(&quoted)))
            }
            (b'\\', None) => {
                self.take(1);
                (INVALID, Sem::None)
            }
            _ => {
                let mut end = self.at;
                while self.byte(end).is_some_and(|b| b != b'\\' && b != b'"') {
                    end += 1;
                }
                let loc = self.take(end - self.at);
                (QQSTRING_TEXT, Sem::Lit(Ok(Value::string(self.text(loc)))))
            }
        }
    }
}

/// A grammar symbol's semantic value.
#[derive(Debug)]
enum Sem {
    None,
    Text(String),
    Lit(Result<Value, String>),
    Ast(Ast),
    /// `a, b, c`: the outputs of each in turn, kept flat while the
    /// grammar nests them to the left, so a long list never nests deep.
    Commas(Vec<Ast>),
    Else(Option<Ast>),
    List(Vec<Sem>),
    Param(String, bool),
    Def(Def),
    Pattern(Pattern),
    ObjPat(PatternKey, Option<Pattern>),
    Pair(Ast, Ast),
}

impl Sem {
    fn ast(self) -> Ast {
        match self {
            Sem::Ast(ast) => ast,
            Sem::Commas(items) => balanced(items),
            Sem::Text(text) => literal_string(text),
            Sem::Lit(Ok(value)) => Ast::Literal(value),
            _ => Ast::Identity,
        }
    }

    fn text(self) -> String {
        match self {
            Sem::Text(text) => text,
            _ => String::new(),
        }
    }

    fn list(self) -> Vec<Sem> {
        match self {
            Sem::List(items) => items,
            _ => Vec::new(),
        }
    }

    fn pattern(self) -> Pattern {
        match self {
            Sem::Pattern(p) => p,
            _ => Pattern::Array(Vec::new()),
        }
    }

    fn patterns(self) -> Vec<Pattern> {
        self.list().into_iter().map(Sem::pattern).collect()
    }
}

fn boxed(sem: Sem) -> Box<Ast> {
    Box::new(sem.ast())
}

struct Parser<'a> {
    source: &'a str,
    lexer: Lexer<'a>,
    errors: Vec<String>,
    /// What a valid program uses that jq_eval leaves to libjq.
    unsupported: Option<&'static str>,
    /// What leaves even the program's errors to libjq: an escape this
    /// lexer cannot word, or a tree too deep to keep.
    unworded: Option<&'static str>,
}

impl<'a> Parser<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            source,
            lexer: Lexer {
                src: source.as_bytes(),
                at: 0,
                cond: Cond::Initial,
                stack: Vec::new(),
                last: Loc::default(),
            },
            errors: Vec::new(),
            unsupported: None,
            unworded: None,
        }
    }

    fn fail(&mut self, loc: Loc, message: &str) {
        let text = locate(self.source, loc, message);
        self.errors.push(text);
    }

    /// yylex, with jq's check of a literal its lexer could not read.
    fn lex(&mut self, g: &Grammar) -> (usize, Sem) {
        let (token, sem) = self.lexer.next(&g.lexemes);
        match sem {
            Sem::Lit(Err(message)) => {
                let loc = self.lexer.last;
                if self.lexer.src[loc.start..loc.end]
                    .iter()
                    .any(|b| *b >= 0x80)
                {
                    self.unworded = Some("an escape of a byte outside ASCII");
                }
                self.fail(loc, &message);
                (token, Sem::Lit(Ok(Value::Null)))
            }
            sem => (token, sem),
        }
    }

    fn syntax_error(&mut self, g: &Grammar, state: usize, token: Option<usize>) {
        let name = |t: usize| {
            let n = TOKENS[t];
            n.strip_prefix('"')
                .and_then(|n| n.strip_suffix('"'))
                .unwrap_or(n)
        };
        let mut message = String::from("syntax error");
        if let Some(token) = token {
            message.push_str(", unexpected ");
            message.push_str(name(token));
            let expected = g.tables.expected(state, ERROR);
            if !expected.is_empty() && expected.len() < 5 {
                for (i, t) in expected.iter().enumerate() {
                    message.push_str(if i == 0 { ", expecting " } else { " or " });
                    message.push_str(name(*t));
                }
            }
        }
        let loc = self.lexer.last;
        self.fail(loc, &message);
    }

    /// yyparse with yacc.c's error recovery: an error pops states until
    /// one shifts `error`, and reports again only after three tokens have
    /// been shifted since. Answers TopLevel's value, or None when the
    /// parse was aborted.
    fn run(&mut self) -> Option<Sem> {
        let g = grammar();
        let t = &g.tables;
        let mut states: Vec<usize> = vec![0];
        let mut values: Vec<Sem> = vec![Sem::None];
        let mut locs: Vec<Loc> = vec![Loc::default()];
        let mut depths: Vec<usize> = vec![0];
        let mut lookahead: Option<(usize, Sem)> = None;
        let mut recovering = 0u8;
        loop {
            if states.len() >= STACK {
                let loc = self.lexer.last;
                self.fail(loc, "memory exhausted");
                return None;
            }
            let state = *states.last().expect("the stack holds state 0");
            if state == t.accept {
                values.pop();
                return values.pop();
            }
            let action = if t.reads(state) {
                if lookahead.is_none() {
                    lookahead = Some(self.lex(g));
                }
                let (token, _) = lookahead.as_ref().expect("read above");
                t.action(state, *token)
            } else {
                Action::Default
            };
            let rule = match action {
                Action::Shift(to) => {
                    recovering = recovering.saturating_sub(1);
                    let (_, sem) = lookahead.take().expect("a shift has a lookahead");
                    states.push(to);
                    values.push(sem);
                    locs.push(self.lexer.last);
                    depths.push(0);
                    continue;
                }
                Action::Reduce(rule) => Some(rule),
                Action::Default => t.default(state),
                Action::Error => None,
            };
            if let Some(rule) = rule {
                let len = t.rules[rule].len;
                let n = states.len();
                let loc = if len > 0 {
                    Loc {
                        start: locs[n - len].start,
                        end: locs[n - 1].end,
                    }
                } else {
                    Loc {
                        start: locs[n - 1].end,
                        end: locs[n - 1].end,
                    }
                };
                let rhs = values.split_off(n - len);
                let rhs_locs = locs.split_off(n - len);
                let rhs_depths = depths.split_off(n - len);
                states.truncate(n - len);
                let act = RULES[rule - 1].1;
                let below = values.last();
                let format = match (act, below) {
                    (Act::QqInterp, Some(Sem::Text(f))) => Some(f.clone()),
                    _ => None,
                };
                let sem = self.act(act, rhs, &rhs_locs, loc, format);
                let mut depth = nesting(act, &rhs_depths);
                let sem = if depth > DEPTH {
                    self.unworded = Some("the program nests too deeply");
                    depth = 1;
                    match sem {
                        Sem::Ast(_) => Sem::Ast(Ast::Identity),
                        Sem::Pattern(_) => Sem::Pattern(Pattern::Array(Vec::new())),
                        other => other,
                    }
                } else {
                    sem
                };
                let to = t.goto(*states.last().expect("state 0 stays"), t.rules[rule].lhs);
                states.push(to);
                values.push(sem);
                locs.push(loc);
                depths.push(depth);
                continue;
            }
            if recovering == 0 {
                let token = lookahead.as_ref().map(|(token, _)| *token);
                self.syntax_error(g, state, token);
            }
            let mut start = self.lexer.last;
            if recovering == 3 {
                match &lookahead {
                    Some((END, _)) => return None,
                    _ => lookahead = None,
                }
            }
            recovering = 3;
            let to = loop {
                let top = *states.last().expect("the stack holds state 0");
                if let Action::Shift(to) = t.action(top, ERROR) {
                    break to;
                }
                if states.len() == 1 {
                    return None;
                }
                start = locs.pop().expect("a location per state");
                states.pop();
                values.pop();
                depths.pop();
            };
            states.push(to);
            values.push(Sem::None);
            locs.push(Loc {
                start: start.start,
                end: self.lexer.last.end,
            });
            depths.push(0);
        }
    }

    fn check_key(&mut self, key: &Ast, loc: Loc) {
        if let Ast::Literal(value) = key {
            if !matches!(value, Value::String(_)) {
                let message = format!(
                    "Cannot use {} ({}) as object key",
                    value.kind(),
                    value.dump_trunc()
                );
                self.fail(loc, &message);
            }
        }
    }

    fn metadata(&mut self, meta: &Ast, loc: Loc) {
        match meta {
            Ast::Literal(Value::Object(_)) => {}
            Ast::Literal(_) => self.fail(loc, "Module metadata must be an object"),
            _ => self.fail(loc, "Module metadata must be constant"),
        }
    }

    fn act(
        &mut self,
        act: Act,
        rhs: Vec<Sem>,
        locs: &[Loc],
        all: Loc,
        format: Option<String>,
    ) -> Sem {
        let mut v: Vec<Option<Sem>> = rhs.into_iter().map(Some).collect();
        let mut take = |i: usize| v.get_mut(i).and_then(Option::take).unwrap_or(Sem::None);
        Sem::Ast(match act {
            Act::TopQuery => return Sem::Ast(take(2).ast()),
            Act::TopDefs => return take(2),
            Act::Nothing => return Sem::None,
            Act::Module => {
                let meta = take(1).ast();
                self.metadata(&meta, locs[1]);
                return Sem::None;
            }
            Act::ImportMeta => {
                let meta = take(1).ast();
                self.metadata(&meta, locs[1]);
                return Sem::None;
            }
            Act::ImportFrom => {
                self.unsupported = Some("modules are loaded by libjq");
                if !matches!(take(0).ast(), Ast::Literal(_)) {
                    self.fail(locs[0], "Import path must be constant");
                }
                return Sem::None;
            }
            Act::Empty => return Sem::List(Vec::new()),
            Act::One => return Sem::List(vec![take(0)]),
            Act::Append => {
                let mut list = take(0).list();
                list.push(take(2));
                return Sem::List(list);
            }
            Act::Prepend => {
                let mut list = take(locs.len() - 1).list();
                list.insert(0, take(0));
                return Sem::List(list);
            }
            Act::Pass => return take(0),
            Act::Take(i) => return take(i),
            Act::DefIn => {
                let Sem::Def(def) = take(0) else {
                    return take(1);
                };
                Ast::Def(Box::new(def), boxed(take(1)))
            }
            Act::Bind => {
                let source = boxed(take(0));
                let patterns = take(2).patterns();
                Ast::Bind(source, patterns, boxed(take(4)))
            }
            Act::Label => Ast::Label(take(1).text(), boxed(take(3))),
            Act::Pipe => Ast::Pipe(boxed(take(0)), boxed(take(2))),
            Act::Comma => {
                let mut items = match take(0) {
                    Sem::Commas(items) => items,
                    other => vec![other.ast()],
                };
                items.push(take(2).ast());
                return Sem::Commas(items);
            }
            Act::Alternative => Ast::Alternative(boxed(take(0)), boxed(take(2))),
            Act::Or => Ast::Or(boxed(take(0)), boxed(take(2))),
            Act::And => Ast::And(boxed(take(0)), boxed(take(2))),
            Act::Update(kind) => Ast::Update(kind, boxed(take(0)), boxed(take(2))),
            Act::Binop(op) => fold(op, take(0).ast(), take(2).ast()),
            Act::FuncDef => {
                return Sem::Def(Def {
                    name: take(1).text(),
                    params: Vec::new(),
                    body: take(3).ast(),
                });
            }
            Act::FuncDefParams => {
                let params = take(3)
                    .list()
                    .into_iter()
                    .filter_map(|p| match p {
                        Sem::Param(name, var) => Some((name, var)),
                        _ => None,
                    })
                    .collect();
                return Sem::Def(Def {
                    name: take(1).text(),
                    params,
                    body: take(6).ast(),
                });
            }
            Act::Param(var) => return Sem::Param(take(0).text(), var),
            Act::TextFormat => return Sem::Text("text".into()),
            Act::QqEmpty => literal_string(String::new()),
            Act::QqText => {
                let text = match take(1) {
                    Sem::Lit(Ok(value)) => Ast::Literal(value),
                    other => other.ast(),
                };
                fold(BinOp::Plus, take(0).ast(), text)
            }
            Act::QqInterp => {
                let format = format.unwrap_or_else(|| "text".into());
                let part = Ast::Pipe(
                    boxed(take(2)),
                    Box::new(Ast::Call(
                        "format".into(),
                        vec![literal_string(format)],
                        Loc::default(),
                    )),
                );
                fold(BinOp::Plus, take(0).ast(), part)
            }
            Act::Elif => {
                let otherwise = match take(4) {
                    Sem::Else(e) => e.map(Box::new),
                    _ => None,
                };
                return Sem::Else(Some(Ast::If(boxed(take(1)), boxed(take(3)), otherwise)));
            }
            Act::Else => return Sem::Else(Some(take(1).ast())),
            Act::End => return Sem::Else(None),
            Act::Identity => Ast::Identity,
            Act::Recurse => Ast::Recurse,
            Act::Break => Ast::Break(take(1).text(), all),
            Act::Fail(message, keep) => {
                self.fail(all, message);
                match keep {
                    Some(i) => take(i).ast(),
                    None => Ast::Identity,
                }
            }
            Act::Index(term, key, opt) => {
                let object = if term {
                    boxed(take(0))
                } else {
                    Box::new(Ast::Identity)
                };
                Ast::Index(object, boxed(take(key)), opt)
            }
            Act::Each(opt) => Ast::Each(boxed(take(0)), opt),
            Act::Slice(from, to, opt) => {
                let term = boxed(take(0));
                let from = from.map(|i| boxed(take(i)));
                let to = to.map(|i| boxed(take(i)));
                Ast::Slice(term, from, to, opt)
            }
            Act::Optional => Ast::Try(boxed(take(0)), None),
            Act::Literal => take(0).ast(),
            Act::Format => Ast::Format(take(0).text()),
            Act::Neg => Ast::Neg(boxed(take(1))),
            Act::Collect => collect(take(1)),
            Act::EmptyArray => Ast::Literal(Value::array(Vec::new())),
            Act::Object => {
                let pairs = take(1)
                    .list()
                    .into_iter()
                    .filter_map(|p| match p {
                        Sem::Pair(k, v) => Some((k, v)),
                        _ => None,
                    })
                    .collect();
                object(pairs)
            }
            Act::Reduce => {
                let source = boxed(take(1));
                let patterns = take(3).patterns();
                Ast::Reduce(source, patterns, boxed(take(5)), boxed(take(7)))
            }
            Act::Foreach(extract) => {
                let source = boxed(take(1));
                let patterns = take(3).patterns();
                let init = boxed(take(5));
                let update = boxed(take(7));
                let extract = extract.then(|| boxed(take(9)));
                Ast::Foreach(source, patterns, init, update, extract)
            }
            Act::If => {
                let otherwise = match take(4) {
                    Sem::Else(e) => e.map(Box::new),
                    _ => None,
                };
                Ast::If(boxed(take(1)), boxed(take(3)), otherwise)
            }
            Act::TryCatch => Ast::Try(boxed(take(1)), Some(boxed(take(3)))),
            Act::Try => Ast::Try(boxed(take(1)), None),
            Act::LoadVn => {
                self.unsupported = Some("$$$$name is jq's private syntax");
                Ast::Var(take(3).text(), all)
            }
            Act::Var => Ast::Var(take(0).text(), all),
            Act::Loc => loc_object(self.source, all),
            Act::Ident => {
                let name = take(0).text();
                match name.as_str() {
                    "true" => Ast::Literal(Value::True),
                    "false" => Ast::Literal(Value::False),
                    "null" => Ast::Literal(Value::Null),
                    _ => Ast::Call(name, Vec::new(), all),
                }
            }
            Act::Call => {
                let args = take(2).list().into_iter().map(Sem::ast).collect();
                Ast::Call(take(0).text(), args, locs[0])
            }
            Act::PatVar => return Sem::Pattern(Pattern::Var(take(0).text())),
            Act::PatArray => return Sem::Pattern(Pattern::Array(take(1).patterns())),
            Act::PatObject => {
                let fields = take(1)
                    .list()
                    .into_iter()
                    .filter_map(|p| match p {
                        Sem::ObjPat(k, v) => Some((k, v)),
                        _ => None,
                    })
                    .collect();
                return Sem::Pattern(Pattern::Object(fields));
            }
            Act::ObjPatVar => return Sem::ObjPat(PatternKey::Var(take(0).text()), None),
            Act::ObjPatVarSub => {
                let name = take(0).text();
                return Sem::ObjPat(PatternKey::Var(name), Some(take(2).pattern()));
            }
            Act::ObjPatKey => {
                let key = take(0).ast();
                return Sem::ObjPat(PatternKey::Expr(key), Some(take(2).pattern()));
            }
            Act::ObjPatExpr => {
                let key = take(1).ast();
                self.check_key(&key, locs[1]);
                return Sem::ObjPat(PatternKey::Expr(key), Some(take(4).pattern()));
            }
            Act::ObjPatError => {
                self.fail(all, PARENS);
                return Sem::ObjPat(PatternKey::Expr(Ast::Identity), Some(take(2).pattern()));
            }
            Act::Keyword(word) => return Sem::Text(word.into()),
            Act::Pair => {
                let key = take(0).ast();
                return Sem::Pair(key, take(2).ast());
            }
            Act::PairString => {
                let key = take(0).ast();
                if !matches!(key, Ast::Literal(_)) {
                    self.unsupported = Some("an interpolated key without a value");
                }
                let value = Ast::Index(Box::new(Ast::Identity), Box::new(key.clone()), false);
                return Sem::Pair(key, value);
            }
            Act::PairVar => {
                let key = Ast::Var(take(0).text(), all);
                return Sem::Pair(key, take(2).ast());
            }
            Act::PairVarShort => {
                let name = take(0).text();
                return Sem::Pair(literal_string(name.clone()), Ast::Var(name, all));
            }
            Act::PairField => {
                let name = take(0).text();
                let value = Ast::Index(
                    Box::new(Ast::Identity),
                    Box::new(literal_string(name.clone())),
                    false,
                );
                return Sem::Pair(literal_string(name), value);
            }
            Act::PairLoc => {
                return Sem::Pair(
                    literal_string("__loc__".into()),
                    loc_object(self.source, all),
                );
            }
            Act::PairExpr => {
                let key = take(1).ast();
                self.check_key(&key, locs[1]);
                return Sem::Pair(key, take(4).ast());
            }
            Act::PairError => {
                self.fail(locs[0], PARENS);
                return Sem::Pair(Ast::Identity, take(2).ast());
            }
        })
    }
}

/// How deep a rule's value nests, from its parts': one more than the
/// deepest, except for a value that holds its parts side by side.
fn nesting(act: Act, depths: &[usize]) -> usize {
    let deepest = depths.iter().copied().max().unwrap_or(0);
    match act {
        Act::Comma
        | Act::Empty
        | Act::One
        | Act::Append
        | Act::Prepend
        | Act::Pass
        | Act::Take(_)
        | Act::Nothing
        | Act::TopQuery
        | Act::TopDefs => deepest,
        _ => deepest + 1,
    }
}

fn literal_string(text: String) -> Ast {
    Ast::Literal(Value::string(text))
}

fn loc_object(source: &str, loc: Loc) -> Ast {
    let start = loc.start.min(source.len());
    let line = source.as_bytes()[..start]
        .iter()
        .filter(|b| **b == b'\n')
        .count()
        + 1;
    let mut object = Object::default();
    object.insert("file".into(), Value::string("<top-level>"));
    object.insert("line".into(), Value::number(line as f64));
    Ast::Literal(Value::object(object))
}

/// gen_binop's constant folding: two constants fold into their result,
/// unless that is an error, which is raised where the expression runs.
/// Repeating a string and subtracting arrays are left to run time, whose
/// limits and step budget bound them.
fn fold(op: BinOp, a: Ast, b: Ast) -> Ast {
    let constants = match (&a, &b) {
        (Ast::Literal(x), Ast::Literal(y))
            if !(op == BinOp::Multiply
                && (matches!(x, Value::String(_)) || matches!(y, Value::String(_)))
                || op == BinOp::Minus
                    && matches!(x, Value::Array(_))
                    && matches!(y, Value::Array(_))) =>
        {
            Some((x, y))
        }
        _ => None,
    };
    if let Some((x, y)) = constants {
        let f = builtin::lookup(op.function(), 2).expect("binop builtin");
        let limits = Limits {
            blocks: usize::MAX,
            items: usize::MAX,
            bytes: usize::MAX,
        };
        match builtin::call(f, vec![Value::Null, x.clone(), y.clone()], limits) {
            Ok(v) => return Ast::Literal(v),
            Err(Fault::Error(_)) => {}
            Err(_) => unreachable!("binops neither halt nor backtrack"),
        }
    }
    Ast::Binop(op, Box::new(a), Box::new(b))
}

/// gen_collect: a list of constants joined by commas, nested to the left
/// as the grammar nests them, is a constant array.
fn collect(inner: Sem) -> Ast {
    let items = match inner {
        Sem::Commas(items) => items,
        other => vec![other.ast()],
    };
    if items.iter().all(|item| matches!(item, Ast::Literal(_))) {
        let values = items
            .into_iter()
            .map(|item| match item {
                Ast::Literal(v) => v,
                _ => unreachable!("every item is a literal"),
            })
            .collect();
        return Ast::Literal(Value::array(values));
    }
    Ast::Collect(Some(Box::new(balanced(items))))
}

/// Commas over `items` in order, nested no deeper than a balanced tree:
/// `(a, b), c` and `a, (b, c)` have the same outputs.
fn balanced(mut items: Vec<Ast>) -> Ast {
    if items.len() == 1 {
        return items.pop().expect("one item");
    }
    let right = items.split_off(items.len() / 2);
    Ast::Comma(Box::new(balanced(items)), Box::new(balanced(right)))
}

/// gen_const_object: constant string keys with constant values make a
/// constant object.
fn object(pairs: Vec<(Ast, Ast)>) -> Ast {
    let mut object = Object::default();
    for (k, v) in &pairs {
        let (Ast::Literal(Value::String(key)), Ast::Literal(value)) = (k, v) else {
            return Ast::Object(pairs);
        };
        object.insert(key.clone(), value.clone());
    }
    Ast::Literal(Value::object(object))
}

#[cfg(test)]
pub(crate) fn tables() -> &'static Tables {
    &grammar().tables
}
