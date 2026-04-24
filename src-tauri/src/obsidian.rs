use crate::store::{anyhow_like as al, Task, TaskNode, TaskStore};
use parking_lot::Mutex;
use rand::Rng;
use std::fs;
use std::path::PathBuf;

const INDENT: &str = "  ";

pub struct ObsidianVaultStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl ObsidianVaultStore {
    pub fn new(path: PathBuf) -> Self {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if !path.exists() {
            let _ = fs::write(&path, "");
        }
        Self { path, lock: Mutex::new(()) }
    }

    fn read_all(&self) -> al::Result<Vec<ParsedLine>> {
        let content = fs::read_to_string(&self.path).map_err(al::err)?;
        Ok(content.lines().map(parse_line).collect())
    }

    fn write_all(&self, lines: &[ParsedLine]) -> al::Result<()> {
        let mut out = String::new();
        for (i, l) in lines.iter().enumerate() {
            out.push_str(&l.render());
            if i + 1 < lines.len() {
                out.push('\n');
            }
        }
        if !out.is_empty() {
            out.push('\n');
        }
        fs::write(&self.path, out).map_err(al::err)
    }

    fn to_tasks(&self, lines: &[ParsedLine]) -> Vec<Task> {
        let mut stack: Vec<(usize, String)> = Vec::new();
        let mut out = Vec::new();
        for line in lines {
            let Some(t) = &line.task else { continue };
            while let Some((depth, _)) = stack.last() {
                if *depth >= line.indent {
                    stack.pop();
                } else {
                    break;
                }
            }
            let parent = stack.last().map(|(_, id)| id.clone());
            out.push(Task {
                id: t.id.clone(),
                text: t.text.clone(),
                done: t.done,
                parent,
            });
            stack.push((line.indent, t.id.clone()));
        }
        out
    }
}

impl TaskStore for ObsidianVaultStore {
    fn list(&self) -> al::Result<Vec<Task>> {
        let _g = self.lock.lock();
        let lines = self.read_all()?;
        Ok(self.to_tasks(&lines))
    }

    fn add(&self, text: &str, parent: Option<&str>) -> al::Result<Task> {
        let _g = self.lock.lock();
        let mut lines = self.read_all()?;
        let id = new_id();
        let new_task = TaskLine { id: id.clone(), text: text.to_string(), done: false };

        let (insert_at, indent) = match parent {
            None => (lines.len(), 0),
            Some(pid) => {
                let (idx, parent_indent) = find_task_line(&lines, pid)
                    .ok_or_else(|| "parent not found".to_string())?;
                let child_indent = parent_indent + 1;
                let mut after = idx + 1;
                while after < lines.len() {
                    match &lines[after].task {
                        Some(_) if lines[after].indent >= child_indent => after += 1,
                        _ => break,
                    }
                }
                (after, child_indent)
            }
        };

        lines.insert(
            insert_at,
            ParsedLine { indent, task: Some(new_task.clone()), raw: None },
        );
        self.write_all(&lines)?;
        Ok(Task {
            id: new_task.id,
            text: new_task.text,
            done: false,
            parent: parent.map(|s| s.to_string()),
        })
    }

    fn set_done(&self, id: &str, done: bool) -> al::Result<()> {
        let _g = self.lock.lock();
        let mut lines = self.read_all()?;
        let mut hit = false;
        for l in lines.iter_mut() {
            if let Some(t) = l.task.as_mut() {
                if t.id == id {
                    t.done = done;
                    hit = true;
                    break;
                }
            }
        }
        if !hit {
            return Err("task not found".into());
        }
        self.write_all(&lines)
    }

    fn set_text(&self, id: &str, text: &str) -> al::Result<()> {
        let _g = self.lock.lock();
        let mut lines = self.read_all()?;
        let mut hit = false;
        for l in lines.iter_mut() {
            if let Some(t) = l.task.as_mut() {
                if t.id == id {
                    t.text = text.to_string();
                    hit = true;
                    break;
                }
            }
        }
        if !hit {
            return Err("task not found".into());
        }
        self.write_all(&lines)
    }

    fn delete(&self, id: &str) -> al::Result<()> {
        let _g = self.lock.lock();
        let lines = self.read_all()?;
        let Some((idx, indent)) = find_task_line(&lines, id) else {
            return Err("task not found".into());
        };
        let mut end = idx + 1;
        while end < lines.len() {
            match &lines[end].task {
                Some(_) if lines[end].indent > indent => end += 1,
                _ => break,
            }
        }
        let mut kept: Vec<ParsedLine> = Vec::with_capacity(lines.len());
        for (i, l) in lines.into_iter().enumerate() {
            if i < idx || i >= end {
                kept.push(l);
            }
        }
        self.write_all(&kept)
    }

    fn replace(&self, tree: &[TaskNode]) -> al::Result<()> {
        let _g = self.lock.lock();
        let mut out = String::new();
        fn walk(nodes: &[TaskNode], indent: usize, out: &mut String) {
            for n in nodes {
                let pad = INDENT.repeat(indent);
                let mark = if n.done { "x" } else { " " };
                let id = if n.id.is_empty() { new_id() } else { n.id.clone() };
                out.push_str(&format!("{}- [{}] {} ^{}\n", pad, mark, n.text, id));
                walk(&n.children, indent + 1, out);
            }
        }
        walk(tree, 0, &mut out);
        fs::write(&self.path, out).map_err(al::err)
    }
}

#[derive(Clone)]
struct TaskLine {
    id: String,
    text: String,
    done: bool,
}

struct ParsedLine {
    indent: usize,
    task: Option<TaskLine>,
    raw: Option<String>,
}

impl ParsedLine {
    fn render(&self) -> String {
        if let Some(t) = &self.task {
            let pad = INDENT.repeat(self.indent);
            let mark = if t.done { "x" } else { " " };
            format!("{}- [{}] {} ^{}", pad, mark, t.text, t.id)
        } else {
            self.raw.clone().unwrap_or_default()
        }
    }
}

fn parse_line(raw: &str) -> ParsedLine {
    let trimmed_left_count = raw.chars().take_while(|c| *c == ' ').count();
    let indent = trimmed_left_count / 2;
    let rest = &raw[trimmed_left_count..];
    let marker = if let Some(r) = rest.strip_prefix("- [ ] ") {
        Some((false, r))
    } else if let Some(r) = rest.strip_prefix("- [x] ").or_else(|| rest.strip_prefix("- [X] ")) {
        Some((true, r))
    } else {
        None
    };
    if let Some((done, body)) = marker {
        let (text, id) = split_block_id(body);
        let id = id.unwrap_or_else(new_id);
        return ParsedLine {
            indent,
            task: Some(TaskLine { id, text: text.trim_end().to_string(), done }),
            raw: None,
        };
    }
    ParsedLine { indent: 0, task: None, raw: Some(raw.to_string()) }
}

fn split_block_id(s: &str) -> (String, Option<String>) {
    if let Some(pos) = s.rfind(" ^") {
        let candidate = &s[pos + 2..];
        if !candidate.is_empty() && candidate.chars().all(|c| c.is_ascii_alphanumeric()) {
            return (s[..pos].to_string(), Some(candidate.to_string()));
        }
    }
    (s.to_string(), None)
}

fn find_task_line(lines: &[ParsedLine], id: &str) -> Option<(usize, usize)> {
    lines.iter().enumerate().find_map(|(i, l)| {
        l.task.as_ref().filter(|t| t.id == id).map(|_| (i, l.indent))
    })
}

fn new_id() -> String {
    const ALPHA: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..6)
        .map(|_| ALPHA[rng.gen_range(0..ALPHA.len())] as char)
        .collect()
}
