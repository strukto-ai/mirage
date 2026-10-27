// Adapted from jq 1.8.2 (MIT), src/lexer.l and src/parser.y. See licenses/third_party/jq.txt.

use super::value::{Number, Value};

const DEPTH: usize = 512;

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Ident(String),
    Field(String),
    Var(String),
    Loc,
    Format(String),
    Num(String),
    Str(Vec<Piece>),
    Keyword(&'static str),
    Op(&'static str),
    Eof,
}

#[derive(Clone, Debug, PartialEq)]
enum Piece {
    Text(String),
    Interp(Vec<(Tok, usize)>),
}

const KEYWORDS: &[&str] = &[
    "def", "if", "then", "elif", "else", "end", "as", "reduce", "foreach", "try", "catch", "label",
    "import", "include", "and", "or", "__loc__",
];

const OPS: &[&str] = &[
    "?//", "//=", "!=", "==", "//", "|=", "+=", "-=", "*=", "/=", "%=", "<=", ">=", "..", "=", "|",
    ",", "+", "-", "*", "/", "%", "<", ">", ".", "[", "]", "{", "}", "(", ")", ":", ";", "?",
];

struct Lexer<'a> {
    src: &'a [u8],
    at: usize,
    line: usize,
}

impl Lexer<'_> {
    fn skip(&mut self) {
        while self.at < self.src.len() {
            match self.src[self.at] {
                b'\n' => {
                    self.line += 1;
                    self.at += 1;
                }
                b' ' | b'\t' | b'\r' => self.at += 1,
                b'#' => {
                    while self.at < self.src.len() && self.src[self.at] != b'\n' {
                        self.at += 1;
                    }
                }
                _ => break,
            }
        }
    }

    fn ident_at(&self, at: usize) -> usize {
        let mut end = at;
        while end < self.src.len()
            && (self.src[end].is_ascii_alphanumeric() || self.src[end] == b'_')
        {
            end += 1;
        }
        end
    }

    fn ident(&mut self, modules: bool) -> String {
        let start = self.at;
        loop {
            self.at = self.ident_at(self.at);
            if modules
                && self.src[self.at..].starts_with(b"::")
                && self
                    .src
                    .get(self.at + 2)
                    .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_')
            {
                self.at += 2;
                continue;
            }
            break;
        }
        String::from_utf8_lossy(&self.src[start..self.at]).into_owned()
    }

    fn tokens(&mut self, until_close: bool) -> Result<Vec<(Tok, usize)>, String> {
        let mut out = Vec::new();
        let mut depth = 0usize;
        loop {
            self.skip();
            let line = self.line;
            let Some(&c) = self.src.get(self.at) else {
                if until_close {
                    return Err("unterminated string interpolation".into());
                }
                out.push((Tok::Eof, line));
                return Ok(out);
            };
            let next = self.src.get(self.at + 1).copied();
            let tok = if c.is_ascii_alphabetic() || c == b'_' {
                let name = self.ident(true);
                match KEYWORDS.iter().find(|k| **k == name) {
                    Some(k) => Tok::Keyword(k),
                    None => Tok::Ident(name),
                }
            } else if c == b'.' && next.is_some_and(|n| n.is_ascii_alphabetic() || n == b'_') {
                self.at += 1;
                Tok::Field(self.ident(false))
            } else if c.is_ascii_digit() || (c == b'.' && next.is_some_and(|n| n.is_ascii_digit()))
            {
                Tok::Num(self.number())
            } else if c == b'$' {
                if self.src[self.at..].starts_with(b"$__loc__")
                    && !self
                        .src
                        .get(self.at + 8)
                        .is_some_and(|n| n.is_ascii_alphanumeric() || *n == b'_')
                {
                    self.at += 8;
                    Tok::Loc
                } else {
                    self.at += 1;
                    while self.src.get(self.at) == Some(&b'$') {
                        self.at += 1;
                    }
                    if !self
                        .src
                        .get(self.at)
                        .is_some_and(|n| n.is_ascii_alphabetic() || *n == b'_')
                    {
                        return Err("syntax error: $ without a name".into());
                    }
                    Tok::Var(self.ident(true))
                }
            } else if c == b'@' {
                self.at += 1;
                let end = self.ident_at(self.at);
                let name = String::from_utf8_lossy(&self.src[self.at..end]).into_owned();
                self.at = end;
                Tok::Format(name)
            } else if c == b'"' {
                self.at += 1;
                Tok::Str(self.string()?)
            } else {
                let Some(op) = OPS
                    .iter()
                    .find(|op| self.src[self.at..].starts_with(op.as_bytes()))
                else {
                    return Err(format!(
                        "syntax error: unexpected character '{}'",
                        c as char
                    ));
                };
                self.at += op.len();
                if until_close {
                    if *op == "(" {
                        depth += 1;
                    } else if *op == ")" {
                        if depth == 0 {
                            out.push((Tok::Eof, line));
                            return Ok(out);
                        }
                        depth -= 1;
                    }
                }
                Tok::Op(op)
            };
            out.push((tok, line));
        }
    }

    fn number(&mut self) -> String {
        let start = self.at;
        while self.src.get(self.at).is_some_and(|c| c.is_ascii_digit()) {
            self.at += 1;
        }
        if self.src.get(self.at) == Some(&b'.') {
            self.at += 1;
            while self.src.get(self.at).is_some_and(|c| c.is_ascii_digit()) {
                self.at += 1;
            }
        }
        if matches!(self.src.get(self.at), Some(b'e' | b'E')) {
            let save = self.at;
            self.at += 1;
            if matches!(self.src.get(self.at), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if self.src.get(self.at).is_some_and(|c| c.is_ascii_digit()) {
                while self.src.get(self.at).is_some_and(|c| c.is_ascii_digit()) {
                    self.at += 1;
                }
            } else {
                self.at = save;
            }
        }
        let text = String::from_utf8_lossy(&self.src[start..self.at]).into_owned();
        match text.strip_prefix('.') {
            Some(rest) => format!("0.{rest}"),
            None => text,
        }
    }

    fn string(&mut self) -> Result<Vec<Piece>, String> {
        let mut pieces = Vec::new();
        let mut text: Vec<u8> = Vec::new();
        loop {
            let Some(&c) = self.src.get(self.at) else {
                return Err("unterminated string".into());
            };
            self.at += 1;
            match c {
                b'"' => break,
                b'\n' => {
                    self.line += 1;
                    text.push(c);
                }
                b'\\' => {
                    let Some(&e) = self.src.get(self.at) else {
                        return Err("unterminated string".into());
                    };
                    self.at += 1;
                    match e {
                        b'(' => {
                            if !text.is_empty() {
                                pieces
                                    .push(Piece::Text(String::from_utf8_lossy(&text).into_owned()));
                                text.clear();
                            }
                            pieces.push(Piece::Interp(self.tokens(true)?));
                        }
                        b'n' => text.push(b'\n'),
                        b't' => text.push(b'\t'),
                        b'r' => text.push(b'\r'),
                        b'b' => text.push(8),
                        b'f' => text.push(12),
                        b'/' | b'\\' | b'"' => text.push(e),
                        b'u' => {
                            let unit = self.hex4()?;
                            let point = if (0xD800..0xDC00).contains(&unit)
                                && self.src[self.at..].starts_with(b"\\u")
                            {
                                self.at += 2;
                                let low = self.hex4()?;
                                if (0xDC00..0xE000).contains(&low) {
                                    0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)
                                } else {
                                    0xFFFD
                                }
                            } else {
                                unit
                            };
                            let ch = char::from_u32(point).unwrap_or('\u{FFFD}');
                            let mut buf = [0u8; 4];
                            text.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                        }
                        _ => return Err("invalid escape".into()),
                    }
                }
                _ => text.push(c),
            }
        }
        if !text.is_empty() || pieces.is_empty() {
            pieces.push(Piece::Text(String::from_utf8_lossy(&text).into_owned()));
        }
        Ok(pieces)
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let digits = self
            .src
            .get(self.at..self.at + 4)
            .ok_or("invalid \\u escape")?;
        let text = std::str::from_utf8(digits).map_err(|_| "invalid \\u escape")?;
        let unit = u32::from_str_radix(text, 16).map_err(|_| "invalid \\u escape")?;
        self.at += 4;
        Ok(unit)
    }
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
    Break(String),
    Def(Box<Def>, Box<Ast>),
    Call(String, Vec<Ast>),
    Var(String),
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

/// Parse a whole program.
pub(crate) fn parse(source: &str) -> Result<Ast, String> {
    let tokens = Lexer {
        src: source.as_bytes(),
        at: 0,
        line: 1,
    }
    .tokens(false)?;
    let mut parser = Parser {
        tokens,
        at: 0,
        depth: 0,
    };
    let ast = parser.pipe()?;
    parser.expect_eof()?;
    Ok(ast)
}

/// Parse a library of definitions, as jq reads builtin.jq.
pub(crate) fn parse_defs(source: &str) -> Result<Vec<Def>, String> {
    let tokens = Lexer {
        src: source.as_bytes(),
        at: 0,
        line: 1,
    }
    .tokens(false)?;
    let mut parser = Parser {
        tokens,
        at: 0,
        depth: 0,
    };
    let mut defs = Vec::new();
    while parser.peek() == &Tok::Keyword("def") {
        defs.push(parser.def()?);
    }
    parser.expect_eof()?;
    Ok(defs)
}

struct Parser {
    tokens: Vec<(Tok, usize)>,
    at: usize,
    depth: usize,
}

fn binop(op: &str) -> Option<(u8, bool, BinOp)> {
    Some(match op {
        "+" => (6, false, BinOp::Plus),
        "-" => (6, false, BinOp::Minus),
        "*" => (7, false, BinOp::Multiply),
        "/" => (7, false, BinOp::Divide),
        "%" => (7, false, BinOp::Mod),
        "==" => (5, false, BinOp::Equal),
        "!=" => (5, false, BinOp::NotEqual),
        "<" => (5, false, BinOp::Less),
        "<=" => (5, false, BinOp::LessEq),
        ">" => (5, false, BinOp::Greater),
        ">=" => (5, false, BinOp::GreaterEq),
        _ => return None,
    })
}

fn update(op: &str) -> Option<Update> {
    Some(match op {
        "=" => Update::Assign,
        "|=" => Update::Modify,
        "+=" => Update::Arith(BinOp::Plus),
        "-=" => Update::Arith(BinOp::Minus),
        "*=" => Update::Arith(BinOp::Multiply),
        "/=" => Update::Arith(BinOp::Divide),
        "%=" => Update::Arith(BinOp::Mod),
        "//=" => Update::Alternative,
        _ => return None,
    })
}

impl Parser {
    fn peek(&self) -> &Tok {
        &self.tokens[self.at].0
    }

    fn line(&self) -> usize {
        self.tokens[self.at].1
    }

    fn bump(&mut self) -> Tok {
        let tok = self.tokens[self.at].0.clone();
        if self.at + 1 < self.tokens.len() {
            self.at += 1;
        }
        tok
    }

    fn eat(&mut self, tok: &Tok) -> bool {
        if self.peek() == tok {
            self.bump();
            true
        } else {
            false
        }
    }

    fn expect(&mut self, tok: Tok) -> Result<(), String> {
        if self.eat(&tok) {
            Ok(())
        } else {
            Err(format!(
                "syntax error: expected {tok:?}, found {:?}",
                self.peek()
            ))
        }
    }

    fn expect_eof(&self) -> Result<(), String> {
        if self.peek() == &Tok::Eof {
            Ok(())
        } else {
            Err(format!("syntax error: unexpected {:?}", self.peek()))
        }
    }

    fn enter(&mut self) -> Result<(), String> {
        self.depth += 1;
        if self.depth > DEPTH {
            return Err("program nests too deeply".into());
        }
        Ok(())
    }

    /// Query: `|` is right-associative and lowest; definitions, labels
    /// and `as` bindings swallow the rest of the query.
    fn pipe(&mut self) -> Result<Ast, String> {
        self.enter()?;
        let lhs = self.comma()?;
        let ast = if self.eat(&Tok::Op("|")) {
            Ast::Pipe(Box::new(lhs), Box::new(self.pipe()?))
        } else {
            lhs
        };
        self.depth -= 1;
        Ok(ast)
    }

    fn comma(&mut self) -> Result<Ast, String> {
        let mut lhs = self.item()?;
        while self.eat(&Tok::Op(",")) {
            let rhs = self.item()?;
            lhs = Ast::Comma(Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }

    fn item(&mut self) -> Result<Ast, String> {
        match self.peek() {
            Tok::Keyword("def") => {
                let def = self.def()?;
                let body = self.pipe()?;
                Ok(Ast::Def(Box::new(def), Box::new(body)))
            }
            Tok::Keyword("label") => {
                self.bump();
                let Tok::Var(name) = self.bump() else {
                    return Err("syntax error: label needs a $name".into());
                };
                self.expect(Tok::Op("|"))?;
                Ok(Ast::Label(name, Box::new(self.pipe()?)))
            }
            _ => {
                let source = self.expr(0)?;
                if self.eat(&Tok::Keyword("as")) {
                    let patterns = self.patterns()?;
                    self.expect(Tok::Op("|"))?;
                    let body = self.pipe()?;
                    return Ok(Ast::Bind(Box::new(source), patterns, Box::new(body)));
                }
                Ok(source)
            }
        }
    }

    fn def(&mut self) -> Result<Def, String> {
        self.expect(Tok::Keyword("def"))?;
        let name = match self.bump() {
            Tok::Ident(name) => name,
            Tok::Keyword(k) => k.to_string(),
            tok => return Err(format!("syntax error: bad function name {tok:?}")),
        };
        let mut params = Vec::new();
        if self.eat(&Tok::Op("(")) {
            loop {
                match self.bump() {
                    Tok::Ident(p) => params.push((p, false)),
                    Tok::Var(p) => params.push((p, true)),
                    tok => return Err(format!("syntax error: bad parameter {tok:?}")),
                }
                if self.eat(&Tok::Op(")")) {
                    break;
                }
                self.expect(Tok::Op(";"))?;
            }
        }
        self.expect(Tok::Op(":"))?;
        let body = self.pipe()?;
        self.expect(Tok::Op(";"))?;
        Ok(Def { name, params, body })
    }

    /// Expr: binary operators by jq's precedence table.
    fn expr(&mut self, min: u8) -> Result<Ast, String> {
        self.enter()?;
        let mut lhs = self.postfix()?;
        while let Tok::Op(op) | Tok::Keyword(op) = *self.peek() {
            let (prec, right) = match op {
                "//" => (1, true),
                "or" => (3, false),
                "and" => (4, false),
                _ if update(op).is_some() => (2, false),
                _ => match binop(op) {
                    Some((p, r, _)) => (p, r),
                    None => break,
                },
            };
            if prec < min {
                break;
            }
            self.bump();
            let rhs = self.expr(if right { prec } else { prec + 1 })?;
            let (l, r) = (Box::new(lhs), Box::new(rhs));
            lhs = match op {
                "//" => Ast::Alternative(l, r),
                "or" => Ast::Or(l, r),
                "and" => Ast::And(l, r),
                _ => match update(op) {
                    Some(u) => Ast::Update(u, l, r),
                    None => Ast::Binop(binop(op).map(|b| b.2).unwrap_or(BinOp::Plus), l, r),
                },
            };
        }
        self.depth -= 1;
        Ok(lhs)
    }

    fn postfix(&mut self) -> Result<Ast, String> {
        self.enter()?;
        let mut term = self.primary()?;
        loop {
            match self.peek().clone() {
                Tok::Field(name) => {
                    self.bump();
                    let opt = self.eat(&Tok::Op("?"));
                    term = Ast::Index(Box::new(term), Box::new(literal_string(name)), opt);
                }
                Tok::Op(".") if matches!(self.tokens[self.at + 1].0, Tok::Str(_)) => {
                    self.bump();
                    let key = self.string(None)?;
                    let opt = self.eat(&Tok::Op("?"));
                    term = Ast::Index(Box::new(term), Box::new(key), opt);
                }
                Tok::Op(".") if self.tokens[self.at + 1].0 == Tok::Op("[") => {
                    self.bump();
                }
                Tok::Op("[") => {
                    self.bump();
                    term = self.bracket(term)?;
                }
                Tok::Op("?") => {
                    self.bump();
                    term = Ast::Try(Box::new(term), None);
                }
                _ => break,
            }
        }
        self.depth -= 1;
        Ok(term)
    }

    fn bracket(&mut self, term: Ast) -> Result<Ast, String> {
        let term = Box::new(term);
        if self.eat(&Tok::Op("]")) {
            let opt = self.eat(&Tok::Op("?"));
            return Ok(Ast::Each(term, opt));
        }
        if self.eat(&Tok::Op(":")) {
            let to = self.pipe()?;
            self.expect(Tok::Op("]"))?;
            let opt = self.eat(&Tok::Op("?"));
            return Ok(Ast::Slice(term, None, Some(Box::new(to)), opt));
        }
        let key = self.pipe()?;
        if self.eat(&Tok::Op(":")) {
            let to = if self.peek() == &Tok::Op("]") {
                None
            } else {
                Some(Box::new(self.pipe()?))
            };
            self.expect(Tok::Op("]"))?;
            let opt = self.eat(&Tok::Op("?"));
            return Ok(Ast::Slice(term, Some(Box::new(key)), to, opt));
        }
        self.expect(Tok::Op("]"))?;
        let opt = self.eat(&Tok::Op("?"));
        Ok(Ast::Index(term, Box::new(key), opt))
    }

    fn string(&mut self, format: Option<String>) -> Result<Ast, String> {
        let Tok::Str(pieces) = self.bump() else {
            return Err("syntax error: expected a string".into());
        };
        let format = format.unwrap_or_else(|| "text".into());
        let mut acc: Option<Ast> = None;
        for piece in pieces {
            let part = match piece {
                Piece::Text(text) => literal_string(text),
                Piece::Interp(tokens) => {
                    let mut sub = Parser {
                        tokens,
                        at: 0,
                        depth: self.depth,
                    };
                    let inner = sub.pipe()?;
                    sub.expect_eof()?;
                    Ast::Pipe(
                        Box::new(inner),
                        Box::new(Ast::Call(
                            "format".into(),
                            vec![literal_string(format.clone())],
                        )),
                    )
                }
            };
            acc = Some(match acc {
                None => match part {
                    Ast::Literal(_) => part,
                    other => fold_plus(literal_string(String::new()), other),
                },
                Some(prev) => fold_plus(prev, part),
            });
        }
        Ok(acc.unwrap_or_else(|| literal_string(String::new())))
    }

    fn primary(&mut self) -> Result<Ast, String> {
        let line = self.line();
        let tok = self.bump();
        Ok(match tok {
            Tok::Op(".") => {
                if matches!(self.peek(), Tok::Str(_)) {
                    let key = self.string(None)?;
                    let opt = self.eat(&Tok::Op("?"));
                    Ast::Index(Box::new(Ast::Identity), Box::new(key), opt)
                } else {
                    Ast::Identity
                }
            }
            Tok::Field(name) => {
                let opt = self.eat(&Tok::Op("?"));
                Ast::Index(Box::new(Ast::Identity), Box::new(literal_string(name)), opt)
            }
            Tok::Op("..") => Ast::Recurse,
            Tok::Num(text) => Ast::Literal(Value::Number(Number::literal(&text))),
            Tok::Str(_) => {
                self.at -= 1;
                self.string(None)?
            }
            Tok::Format(name) => {
                if matches!(self.peek(), Tok::Str(_)) {
                    self.string(Some(name))?
                } else {
                    Ast::Format(name)
                }
            }
            Tok::Op("-") => Ast::Neg(Box::new(self.postfix()?)),
            Tok::Op("(") => {
                let inner = self.pipe()?;
                self.expect(Tok::Op(")"))?;
                inner
            }
            Tok::Op("[") => {
                if self.eat(&Tok::Op("]")) {
                    Ast::Collect(None)
                } else {
                    let inner = self.pipe()?;
                    self.expect(Tok::Op("]"))?;
                    Ast::Collect(Some(Box::new(inner)))
                }
            }
            Tok::Op("{") => self.object(line)?,
            Tok::Keyword("reduce") => {
                let source = self.postfix()?;
                self.expect(Tok::Keyword("as"))?;
                let patterns = self.patterns()?;
                self.expect(Tok::Op("("))?;
                let init = self.pipe()?;
                self.expect(Tok::Op(";"))?;
                let body = self.pipe()?;
                self.expect(Tok::Op(")"))?;
                Ast::Reduce(Box::new(source), patterns, Box::new(init), Box::new(body))
            }
            Tok::Keyword("foreach") => {
                let source = self.postfix()?;
                self.expect(Tok::Keyword("as"))?;
                let patterns = self.patterns()?;
                self.expect(Tok::Op("("))?;
                let init = self.pipe()?;
                self.expect(Tok::Op(";"))?;
                let update = self.pipe()?;
                let extract = if self.eat(&Tok::Op(";")) {
                    Some(Box::new(self.pipe()?))
                } else {
                    None
                };
                self.expect(Tok::Op(")"))?;
                Ast::Foreach(
                    Box::new(source),
                    patterns,
                    Box::new(init),
                    Box::new(update),
                    extract,
                )
            }
            Tok::Keyword("if") => self.conditional()?,
            Tok::Keyword("try") => {
                let body = self.postfix()?;
                let handler = if self.eat(&Tok::Keyword("catch")) {
                    Some(Box::new(self.postfix()?))
                } else {
                    None
                };
                Ast::Try(Box::new(body), handler)
            }
            Tok::Loc => loc(line),
            Tok::Var(name) => Ast::Var(name),
            Tok::Ident(name) if name == "break" => {
                let Tok::Var(label) = self.bump() else {
                    return Err("syntax error: break needs a $label".into());
                };
                Ast::Break(label)
            }
            Tok::Ident(name) => match name.as_str() {
                "true" => Ast::Literal(Value::True),
                "false" => Ast::Literal(Value::False),
                "null" => Ast::Literal(Value::Null),
                _ => {
                    let mut args = Vec::new();
                    if self.eat(&Tok::Op("(")) {
                        loop {
                            args.push(self.pipe()?);
                            if self.eat(&Tok::Op(")")) {
                                break;
                            }
                            self.expect(Tok::Op(";"))?;
                        }
                    }
                    Ast::Call(name, args)
                }
            },
            tok => return Err(format!("syntax error: unexpected {tok:?}")),
        })
    }

    fn conditional(&mut self) -> Result<Ast, String> {
        let cond = self.pipe()?;
        self.expect(Tok::Keyword("then"))?;
        let then = self.pipe()?;
        let otherwise = match self.bump() {
            Tok::Keyword("elif") => Some(Box::new(self.conditional()?)),
            Tok::Keyword("else") => {
                let e = self.pipe()?;
                self.expect(Tok::Keyword("end"))?;
                Some(Box::new(e))
            }
            Tok::Keyword("end") => None,
            tok => return Err(format!("syntax error: unexpected {tok:?} in if")),
        };
        Ok(Ast::If(Box::new(cond), Box::new(then), otherwise))
    }

    /// ExpD, an object value: terms joined by `|`, or a negated one.
    fn object_value(&mut self) -> Result<Ast, String> {
        let lhs = self.object_unary()?;
        if self.eat(&Tok::Op("|")) {
            return Ok(Ast::Pipe(Box::new(lhs), Box::new(self.object_value()?)));
        }
        Ok(lhs)
    }

    fn object_unary(&mut self) -> Result<Ast, String> {
        if self.eat(&Tok::Op("-")) {
            return Ok(Ast::Neg(Box::new(self.object_unary()?)));
        }
        self.postfix()
    }

    fn object(&mut self, line: usize) -> Result<Ast, String> {
        let mut pairs = Vec::new();
        if self.eat(&Tok::Op("}")) {
            return Ok(Ast::Object(pairs));
        }
        loop {
            let tok = self.peek().clone();
            let (key, short) = match tok {
                Tok::Ident(name) => {
                    self.bump();
                    let field = Ast::Index(
                        Box::new(Ast::Identity),
                        Box::new(literal_string(name.clone())),
                        false,
                    );
                    (literal_string(name), Some(field))
                }
                Tok::Keyword(k) if k != "__loc__" => {
                    self.bump();
                    let field = Ast::Index(
                        Box::new(Ast::Identity),
                        Box::new(literal_string(k.to_string())),
                        false,
                    );
                    (literal_string(k.to_string()), Some(field))
                }
                Tok::Var(name) => {
                    self.bump();
                    if self.peek() == &Tok::Op(":") {
                        (Ast::Var(name), None)
                    } else {
                        (literal_string(name.clone()), Some(Ast::Var(name)))
                    }
                }
                Tok::Loc => {
                    self.bump();
                    (literal_string("__loc__".into()), Some(loc(line)))
                }
                Tok::Str(_) => {
                    let key = self.string(None)?;
                    let field = match &key {
                        Ast::Literal(_) => Some(Ast::Index(
                            Box::new(Ast::Identity),
                            Box::new(key.clone()),
                            false,
                        )),
                        _ => None,
                    };
                    (key, field)
                }
                Tok::Format(name) if matches!(self.tokens[self.at + 1].0, Tok::Str(_)) => {
                    self.bump();
                    (self.string(Some(name))?, None)
                }
                Tok::Op("(") => {
                    self.bump();
                    let key = self.pipe()?;
                    self.expect(Tok::Op(")"))?;
                    (key, None)
                }
                tok => return Err(format!("syntax error: unexpected {tok:?} in object")),
            };
            let value = if self.eat(&Tok::Op(":")) {
                self.object_value()?
            } else {
                short.ok_or("syntax error: object key needs a value")?
            };
            pairs.push((key, value));
            if self.eat(&Tok::Op("}")) {
                return Ok(Ast::Object(pairs));
            }
            self.expect(Tok::Op(","))?;
        }
    }

    /// Patterns: alternatives joined by `?//`, tried in order.
    fn patterns(&mut self) -> Result<Vec<Pattern>, String> {
        let mut patterns = vec![self.pattern()?];
        while self.eat(&Tok::Op("?//")) {
            patterns.push(self.pattern()?);
        }
        Ok(patterns)
    }

    fn pattern(&mut self) -> Result<Pattern, String> {
        match self.bump() {
            Tok::Var(name) => Ok(Pattern::Var(name)),
            Tok::Op("[") => {
                let mut items = Vec::new();
                loop {
                    items.push(self.pattern()?);
                    if self.eat(&Tok::Op("]")) {
                        return Ok(Pattern::Array(items));
                    }
                    self.expect(Tok::Op(","))?;
                }
            }
            Tok::Op("{") => {
                let mut fields = Vec::new();
                loop {
                    let entry = match self.peek().clone() {
                        Tok::Var(name) => {
                            self.bump();
                            let sub = if self.eat(&Tok::Op(":")) {
                                Some(self.pattern()?)
                            } else {
                                None
                            };
                            (PatternKey::Var(name), sub)
                        }
                        Tok::Ident(name) => {
                            self.bump();
                            self.expect(Tok::Op(":"))?;
                            (
                                PatternKey::Expr(literal_string(name)),
                                Some(self.pattern()?),
                            )
                        }
                        Tok::Keyword(k) => {
                            self.bump();
                            self.expect(Tok::Op(":"))?;
                            (
                                PatternKey::Expr(literal_string(k.to_string())),
                                Some(self.pattern()?),
                            )
                        }
                        Tok::Str(_) => {
                            let key = self.string(None)?;
                            self.expect(Tok::Op(":"))?;
                            (PatternKey::Expr(key), Some(self.pattern()?))
                        }
                        Tok::Op("(") => {
                            self.bump();
                            let key = self.pipe()?;
                            self.expect(Tok::Op(")"))?;
                            self.expect(Tok::Op(":"))?;
                            (PatternKey::Expr(key), Some(self.pattern()?))
                        }
                        tok => return Err(format!("syntax error: unexpected {tok:?} in pattern")),
                    };
                    fields.push(entry);
                    if self.eat(&Tok::Op("}")) {
                        return Ok(Pattern::Object(fields));
                    }
                    self.expect(Tok::Op(","))?;
                }
            }
            tok => Err(format!("syntax error: unexpected {tok:?} in pattern")),
        }
    }
}

fn literal_string(text: String) -> Ast {
    Ast::Literal(Value::string(text))
}

fn loc(line: usize) -> Ast {
    let mut object = super::value::Object::default();
    object.insert("file".into(), Value::string("<top-level>"));
    object.insert("line".into(), Value::number(line as f64));
    Ast::Literal(Value::object(object))
}

fn fold_plus(a: Ast, b: Ast) -> Ast {
    if let (Ast::Literal(Value::String(x)), Ast::Literal(Value::String(y))) = (&a, &b) {
        return literal_string(format!("{x}{y}"));
    }
    Ast::Binop(BinOp::Plus, Box::new(a), Box::new(b))
}
