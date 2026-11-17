use std::collections::HashMap;
use std::path::Path;

use anyhow::{bail, Context, Result};
use tauri::AppHandle;

use super::session::PtySession;

#[derive(Default)]
pub struct PtyManager {
    sessions: HashMap<String, PtySession>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create(
        &mut self,
        app: &AppHandle,
        id: &str,
        workspace: &Path,
        rows: u16,
        cols: u16,
        agent: Option<&str>,
    ) -> Result<()> {
        if self.sessions.contains_key(id) {
            bail!("terminale gi\u{e0} esistente: {id}");
        }
        let session = PtySession::start(app, id, workspace, rows, cols, agent)?;
        self.sessions.insert(id.to_string(), session);
        Ok(())
    }

    pub fn write(&mut self, id: &str, data: &str) -> Result<()> {
        let session = self
            .sessions
            .get_mut(id)
            .with_context(|| format!("terminale non trovato: {id}"))?;
        session.write(data)
    }

    pub fn resize(&mut self, id: &str, rows: u16, cols: u16) -> Result<()> {
        let session = self
            .sessions
            .get_mut(id)
            .with_context(|| format!("terminale non trovato: {id}"))?;
        session.resize(rows, cols)
    }

    pub fn snapshot(&self, id: &str) -> Vec<u8> {
        self.sessions
            .get(id)
            .map(PtySession::snapshot)
            .unwrap_or_default()
    }

    pub fn close(&mut self, id: &str) -> bool {
        self.sessions.remove(id).is_some()
    }

    pub fn close_all(&mut self) {
        self.sessions.clear();
    }
}
