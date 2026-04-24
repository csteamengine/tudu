use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MonitorPos {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub vault_folder: PathBuf,
    pub last_list: Option<String>,
    pub hotkey: String,
    pub sticky: bool,
    pub window_width: Option<u32>,
    pub window_height: Option<u32>,
    pub monitor_positions: HashMap<String, MonitorPos>,
}

impl Default for Config {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        Self {
            vault_folder: home.join("TuduVault"),
            last_list: None,
            hotkey: "Ctrl+Alt+Cmd+Space".to_string(),
            sticky: false,
            window_width: None,
            window_height: None,
            monitor_positions: HashMap::new(),
        }
    }
}

pub fn config_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("tudu")
}

pub fn config_path() -> PathBuf { config_dir().join("config.json") }

pub fn load() -> Config {
    let path = config_path();
    match fs::read_to_string(&path) {
        Ok(data) => match serde_json::from_str::<Config>(&data) {
            Ok(c) => c,
            Err(e) => {
                eprintln!(
                    "tudu: failed to parse {} ({}); keeping file, using defaults in memory",
                    path.display(), e
                );
                Config::default()
            }
        },
        Err(_) => { let c = Config::default(); save(&c).ok(); c }
    }
}

pub fn save(c: &Config) -> std::io::Result<()> {
    let dir = config_dir();
    fs::create_dir_all(&dir)?;
    let data = serde_json::to_string_pretty(c).unwrap();
    fs::write(config_path(), data)
}
