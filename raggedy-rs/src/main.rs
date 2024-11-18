use clap::Parser;
use regex::Regex;
use serde::Serialize;
use std::fs;
use std::io::{self, Read};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Directory path to scan for markdown and asciidoc files
    directory: String,
}

#[derive(Debug, Serialize)]
struct Doc {
    rel_path: String,
    content: String,
    head: String,
    headings: Vec<String>,
}

fn main() {
    let args = Args::parse();
    let dir = PathBuf::from(&args.directory);
    let docs = get_doc_paths(&dir)
        .unwrap()
        .iter()
        .map(|path| read_doc(&path, &dir))
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

    println!("{}", serde_json::to_string_pretty(&docs).unwrap());
}

fn get_doc_paths(dir: &PathBuf) -> io::Result<Vec<PathBuf>> {
    let mut paths = Vec::new();

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            let mut subdir_paths = get_doc_paths(&path)?;
            paths.append(&mut subdir_paths);
        } else {
            if let Some(extension) = path.extension() {
                if extension == "md" || extension == "adoc" {
                    paths.push(path);
                }
            }
        }
    }
    Ok(paths)
}

fn read_doc(path: &PathBuf, dir: &PathBuf) -> io::Result<Doc> {
    let mut content = String::new();
    fs::File::open(&path)?.read_to_string(&mut content)?;

    let rel_path = path
        .strip_prefix(dir)
        .unwrap()
        .to_string_lossy()
        .into_owned();

    let is_adoc = path.extension().map_or(false, |ext| ext == "adoc");
    let heading_pattern = if is_adoc {
        Regex::new(r"^=+\s+.*").unwrap()
    } else {
        Regex::new(r"^#+\s+.*").unwrap()
    };

    let headings = content
        .lines()
        .filter(|l| heading_pattern.is_match(l))
        .map(|s| s.to_string())
        .collect::<Vec<String>>();

    let head = content.chars().take(500).collect::<String>();

    Ok(Doc {
        rel_path,
        content,
        head,
        headings,
    })
}
