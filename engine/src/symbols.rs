//! Tree-sitter declaration spans for `mode:"symbol"` (#26).
//!
//! The content index keeps a cheap, regex-derived `symbol_key` posting for
//! "this file defines <name>" (candidate generation). This module is the
//! authority that confirms a candidate and finds the declaration lines:
//! the same trace is re-read from the AST, so a declaration-shaped string
//! literal or a commented-out definition is not a declaration, and access
//! modifiers (`public`, `private`, `pub`) and member methods are.
//!
//! Grammars are compiled in for the corpus languages (TypeScript, TSX,
//! JavaScript, Rust). A file whose language has no grammar returns `None`
//! from `declared_lines`, and the caller keeps its lexical confirmation
//! (Go, Swift and every other extension).

/// A language with a compiled-in grammar.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    TypeScript,
    Tsx,
    JavaScript,
    Rust,
}

/// The grammar for a lowercase extension (without the dot), if any.
pub fn lang_for_ext(ext: &str) -> Option<Lang> {
    match ext {
        "ts" | "mts" | "cts" => Some(Lang::TypeScript),
        "tsx" => Some(Lang::Tsx),
        "js" | "jsx" | "mjs" | "cjs" => Some(Lang::JavaScript),
        "rs" => Some(Lang::Rust),
        _ => None,
    }
}

fn parser(lang: Lang) -> Option<tree_sitter::Parser> {
    let language: tree_sitter::Language = match lang {
        Lang::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
        Lang::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
        Lang::Rust => tree_sitter_rust::LANGUAGE.into(),
    };
    let mut p = tree_sitter::Parser::new();
    p.set_language(&language).ok()?;
    Some(p)
}

/// Node kinds that declare a named symbol, by language family.
fn is_declaration(kind: &str) -> bool {
    matches!(
        kind,
        // TypeScript / JavaScript
        "function_declaration"
            | "generator_function_declaration"
            | "class_declaration"
            | "abstract_class_declaration"
            | "interface_declaration"
            | "type_alias_declaration"
            | "enum_declaration"
            | "method_definition"
            | "public_field_definition"
            | "property_signature"
            | "lexical_declaration"
            | "function_expression"
            | "variable_declarator"
            // Rust
            | "function_item"
            | "struct_item"
            | "enum_item"
            | "trait_item"
            | "type_item"
            | "const_item"
            | "static_item"
            | "mod_item"
            | "macro_definition"
            | "impl_item"
    )
}

/// Node kinds whose subtree is a body: nothing inside declares a file-level
/// symbol, so stop descending (this is what drops nested functions).
fn is_body(kind: &str) -> bool {
    matches!(kind, "statement_block" | "block" | "arrow_function" | "function_body" | "interface_body" | "enum_body")
}

/// The name a declaration node introduces, if it has one.
fn declaration_name(node: &tree_sitter::Node<'_>, buf: &[u8]) -> Option<String> {
    let sym = |n: tree_sitter::Node<'_>| n.utf8_text(buf).ok().map(str::to_string);
    if node.kind() == "lexical_declaration" {
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if child.kind() == "variable_declarator"
                && let Some(name) = child.child_by_field_name("name")
                && (name.kind() == "identifier" || name.kind() == "type_identifier")
            {
                return sym(name);
            }
        }
        return None;
    }
    if let Some(name) = node.child_by_field_name("name") {
        return sym(name);
    }
    // Rust `impl Policy { .. }` names its type, not a `name` field.
    if node.kind() == "impl_item"
        && let Some(ty) = node.child_by_field_name("type")
    {
        if let Some(last) = ty.child_by_field_name("name") {
            return sym(last);
        }
        return sym(ty);
    }
    None
}

/// One-based lines at which `name` is declared, when the language has a
/// grammar. `None` means "no grammar for this file": the caller must keep
/// its lexical confirmation.
pub fn declared_lines(buf: &[u8], lang: Lang, name: &str) -> Option<Vec<usize>> {
    let mut p = parser(lang)?;
    let tree = p.parse(buf, None)?;
    let root = tree.root_node();
    let mut lines = Vec::new();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];
    let mut visited = 0usize;
    while let Some(node) = stack.pop() {
        visited += 1;
        if visited > 200_000 {
            break;
        }
        if is_declaration(node.kind())
            && let Some(n) = declaration_name(&node, buf)
            && n == name
        {
            lines.push(node.start_position().row + 1);
        }
        if is_body(node.kind()) {
            continue;
        }
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            stack.push(child);
        }
    }
    lines.sort_unstable();
    lines.dedup();
    Some(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typescript_declarations_include_access_modifiers() {
        let src = br#"
export class UltraSearchClient {
  public applyProximityRanking(a: string) {}
  private trySpawnDaemon() {}
  run() {}
}
const pattern = "export class UltraSearchClient {";
"#;
        let lines = declared_lines(src, Lang::TypeScript, "UltraSearchClient").unwrap();
        // The class declaration only: the mock string is not a declaration.
        assert_eq!(lines, vec![2]);
        let lines = declared_lines(src, Lang::TypeScript, "applyProximityRanking").unwrap();
        assert_eq!(lines, vec![3]);
        let lines = declared_lines(src, Lang::TypeScript, "trySpawnDaemon").unwrap();
        assert_eq!(lines, vec![4]);
        let lines = declared_lines(src, Lang::TypeScript, "run").unwrap();
        assert_eq!(lines, vec![5]);
    }

    #[test]
    fn rust_declarations() {
        let src = br#"
pub struct Policy { x: u32 }
impl Policy {
    pub fn policy(&self) -> u32 { self.x }
    fn nearness(a: u32) -> u32 { a }
}
"#;
        assert_eq!(declared_lines(src, Lang::Rust, "Policy").unwrap(), vec![2, 3]);
        assert_eq!(declared_lines(src, Lang::Rust, "policy").unwrap(), vec![4]);
        assert_eq!(declared_lines(src, Lang::Rust, "nearness").unwrap(), vec![5]);
    }

    #[test]
    fn unsupported_language_is_none() {
        assert!(declared_lines(b"x", Lang::TypeScript, "x").is_some());
        assert!(lang_for_ext("go").is_none());
        assert!(lang_for_ext("swift").is_none());
    }
}
