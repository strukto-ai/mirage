use super::text::read_escape;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Kind {
    Number,
    String,
    Ere,
    Name,
    FuncName,
    Builtin,
    Keyword,
    Newline,
    Eof,
    Op,
}

/// One token: its kind and its text, a string's or an expression's with
/// the escapes the lexer reads already applied.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Token {
    pub(super) kind: Kind,
    pub(super) text: Vec<u8>,
}

const KEYWORDS: [&[u8]; 20] = [
    b"BEGIN",
    b"END",
    b"function",
    b"func",
    b"break",
    b"continue",
    b"delete",
    b"do",
    b"else",
    b"exit",
    b"for",
    b"getline",
    b"if",
    b"in",
    b"next",
    b"nextfile",
    b"print",
    b"printf",
    b"return",
    b"while",
];

/// mawk 1.3.4's builtin functions, each with the fewest and the most
/// arguments it takes.
pub(super) const BUILTINS: [(&[u8], usize, usize); 22] = [
    (b"atan2", 2, 2),
    (b"close", 1, 1),
    (b"cos", 1, 1),
    (b"exp", 1, 1),
    (b"fflush", 0, 1),
    (b"gsub", 2, 3),
    (b"index", 2, 2),
    (b"int", 1, 1),
    (b"length", 0, 1),
    (b"log", 1, 1),
    (b"match", 2, 2),
    (b"rand", 0, 0),
    (b"sin", 1, 1),
    (b"split", 2, 3),
    (b"sprintf", 1, 255),
    (b"sqrt", 1, 1),
    (b"srand", 0, 1),
    (b"sub", 2, 3),
    (b"substr", 2, 3),
    (b"system", 1, 1),
    (b"tolower", 1, 1),
    (b"toupper", 1, 1),
];

const TWO_CHAR_OPS: [&[u8]; 17] = [
    b"+=", b"-=", b"*=", b"/=", b"%=", b"^=", b"==", b"!=", b"<=", b">=", b"&&", b"||", b"!~",
    b"++", b"--", b">>", b"**",
];

const ONE_CHAR_OPS: &[u8] = b"{}()[],;+-*/%^!><|?:~$=";

fn word_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_'
}

fn error(message: &[u8]) -> Vec<u8> {
    [b"awk: syntax error: ".as_slice(), message].concat()
}

struct Lexer<'a> {
    src: &'a [u8],
    pos: usize,
    tokens: Vec<Token>,
}

impl Lexer<'_> {
    fn at(&self, pos: usize) -> Option<u8> {
        self.src.get(pos).copied()
    }

    fn push(&mut self, kind: Kind, text: &[u8]) {
        self.tokens.push(Token {
            kind,
            text: text.to_vec(),
        });
    }

    /// Whether `/` here divides: POSIX reads it as division after what can
    /// end an expression and as the start of an expression otherwise.
    fn divides(&self) -> bool {
        self.tokens.last().is_some_and(|last| match last.kind {
            Kind::Number | Kind::String | Kind::Name | Kind::Ere | Kind::Builtin => true,
            Kind::Op => matches!(last.text.as_slice(), b")" | b"]" | b"$" | b"++" | b"--"),
            _ => false,
        })
    }

    fn string(&mut self) -> Result<(), Vec<u8>> {
        self.pos += 1;
        let mut out = Vec::new();
        while let Some(c) = self.at(self.pos) {
            match c {
                b'"' => {
                    self.pos += 1;
                    self.push(Kind::String, &out);
                    return Ok(());
                }
                b'\n' => return Err(error(b"newline in string")),
                b'\\' => {
                    if self.pos + 1 >= self.src.len() {
                        return Err(error(b"unterminated string"));
                    }
                    self.pos = read_escape(self.src, self.pos + 1, &mut out);
                }
                _ => {
                    out.push(c);
                    self.pos += 1;
                }
            }
        }
        Err(error(b"unterminated string"))
    }

    fn ere(&mut self) -> Result<(), Vec<u8>> {
        self.pos += 1;
        let mut out = Vec::new();
        while let Some(c) = self.at(self.pos) {
            match c {
                b'/' => {
                    self.pos += 1;
                    self.push(Kind::Ere, &out);
                    return Ok(());
                }
                b'\n' => return Err(error(b"newline in regex")),
                // Only `\/` collapses here; every other escape belongs to
                // the expression, which needs its backslash.
                b'\\' if self.pos + 1 < self.src.len() => {
                    let next = self.src[self.pos + 1];
                    if next != b'/' {
                        out.push(b'\\');
                    }
                    out.push(next);
                    self.pos += 2;
                }
                _ => {
                    out.push(c);
                    self.pos += 1;
                }
            }
        }
        Err(error(b"unterminated regex"))
    }

    fn number(&mut self) {
        let start = self.pos;
        let mut dot = false;
        while let Some(c) = self.at(self.pos) {
            if c.is_ascii_digit() || (c == b'.' && !dot) {
                dot |= c == b'.';
                self.pos += 1;
            } else {
                break;
            }
        }
        if matches!(self.at(self.pos), Some(b'e' | b'E')) {
            let save = self.pos;
            self.pos += 1;
            if matches!(self.at(self.pos), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if self.at(self.pos).is_some_and(|c| c.is_ascii_digit()) {
                while self.at(self.pos).is_some_and(|c| c.is_ascii_digit()) {
                    self.pos += 1;
                }
            } else {
                self.pos = save;
            }
        }
        let text = self.src[start..self.pos].to_vec();
        self.tokens.push(Token {
            kind: Kind::Number,
            text,
        });
    }

    fn word(&mut self) {
        let start = self.pos;
        while self
            .at(self.pos)
            .is_some_and(|c| word_start(c) || c.is_ascii_digit())
        {
            self.pos += 1;
        }
        let word = &self.src[start..self.pos];
        let kind = if KEYWORDS.contains(&word) {
            Kind::Keyword
        } else if BUILTINS.iter().any(|(name, _, _)| *name == word) {
            Kind::Builtin
        } else if self.at(self.pos) == Some(b'(') {
            // A name glued to `(` is a call; a space makes it a
            // concatenation with a parenthesised expression.
            Kind::FuncName
        } else {
            Kind::Name
        };
        self.push(kind, word);
    }

    fn operator(&mut self) -> Result<(), Vec<u8>> {
        let rest = &self.src[self.pos..];
        if rest.starts_with(b"**=") {
            self.pos += 3;
            self.push(Kind::Op, b"^=");
            return Ok(());
        }
        if let Some(op) = TWO_CHAR_OPS.iter().find(|op| rest.starts_with(op)) {
            self.pos += 2;
            let op: &[u8] = if *op == b"**" { b"^" } else { op };
            self.push(Kind::Op, op);
            return Ok(());
        }
        let c = rest[0];
        if !ONE_CHAR_OPS.contains(&c) {
            return Err(error(&[b"unexpected character '", &[c][..], b"'"].concat()));
        }
        self.pos += 1;
        self.push(Kind::Op, &[c]);
        Ok(())
    }

    fn run(mut self) -> Result<Vec<Token>, Vec<u8>> {
        while let Some(c) = self.at(self.pos) {
            match c {
                b'\\' if self.at(self.pos + 1) == Some(b'\n') => self.pos += 2,
                b' ' | b'\t' | b'\r' => self.pos += 1,
                b'#' => {
                    while self.at(self.pos).is_some_and(|c| c != b'\n') {
                        self.pos += 1;
                    }
                }
                b'\n' => {
                    self.pos += 1;
                    self.push(Kind::Newline, b"\n");
                }
                b'"' => self.string()?,
                b'/' if !self.divides() => self.ere()?,
                _ if c.is_ascii_digit()
                    || (c == b'.' && self.at(self.pos + 1).is_some_and(|d| d.is_ascii_digit())) =>
                {
                    self.number();
                }
                _ if word_start(c) => self.word(),
                _ => self.operator()?,
            }
        }
        self.push(Kind::Eof, b"");
        Ok(self.tokens)
    }
}

/// Split a program into tokens, ending in one `Eof`; a refusal is the
/// message awk prints.
pub(super) fn tokenize(src: &[u8]) -> Result<Vec<Token>, Vec<u8>> {
    Lexer {
        src,
        pos: 0,
        tokens: Vec::new(),
    }
    .run()
}
