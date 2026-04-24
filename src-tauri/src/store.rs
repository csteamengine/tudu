use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub text: String,
    pub done: bool,
    pub parent: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TaskNode {
    pub id: String,
    pub text: String,
    pub done: bool,
    #[serde(default)]
    pub children: Vec<TaskNode>,
}

pub trait TaskStore: Send + Sync {
    fn list(&self) -> anyhow_like::Result<Vec<Task>>;
    fn add(&self, text: &str, parent: Option<&str>) -> anyhow_like::Result<Task>;
    fn set_done(&self, id: &str, done: bool) -> anyhow_like::Result<()>;
    fn set_text(&self, id: &str, text: &str) -> anyhow_like::Result<()>;
    fn delete(&self, id: &str) -> anyhow_like::Result<()>;
    fn replace(&self, tree: &[TaskNode]) -> anyhow_like::Result<()>;
}

pub mod anyhow_like {
    pub type Result<T> = std::result::Result<T, String>;
    pub fn err<E: std::fmt::Display>(e: E) -> String {
        e.to_string()
    }
}
