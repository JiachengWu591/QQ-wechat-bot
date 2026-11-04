//! Runs the engine as a child process and makes sure it can't outlive the app.

use serde::Serialize;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// The app runs from this checkout for now. It's only used on this machine; a standalone
// install would need to bundle Node and the engine instead.
const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");
const ALLOWED_ORIGINS: &str = "http://tauri.localhost,tauri://localhost,http://127.0.0.1:5173";
const MAX_QUICK_FAILURES: u32 = 5;

#[derive(Clone, Serialize)]
pub struct Connection {
    pub port: u16,
    pub token: String,
}

impl Connection {
    pub fn new() -> std::io::Result<Self> {
        let port = TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
        let token: String = rand::random::<[u8; 24]>().iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(Self { port, token })
    }
}

/// Puts this process in a Job Object that kills every member when its last handle closes.
/// Children join automatically, and the handle closes however the process ends, so even a
/// crash or a forced kill of the app takes the engine and anything it started with it.
pub fn tie_children_to_this_process() -> Result<(), win32job::JobError> {
    let job = win32job::Job::create()?;
    let mut limits = job.query_extended_limit_info()?;
    limits.limit_kill_on_job_close();
    job.set_extended_limit_info(&mut limits)?;
    job.assign_current_process()?;
    // Dropping the job would close the handle and kill this process too.
    std::mem::forget(job);
    Ok(())
}

fn start(connection: &Connection) -> std::io::Result<Child> {
    let root = PathBuf::from(REPO_ROOT);
    let mut command = Command::new("node");
    command
        .current_dir(root.join("packages/engine"))
        .arg("--disable-warning=ExperimentalWarning")
        .arg(format!("--env-file-if-exists={}", root.join("spikes/.env.local").display()))
        .arg("src/main.ts")
        .env("SHU_ENGINE_PORT", connection.port.to_string())
        .env("SHU_ENGINE_TOKEN", &connection.token)
        .env("SHU_ALLOWED_ORIGINS", ALLOWED_ORIGINS);

    // A session started from inside Claude passes on its own login, which would otherwise
    // override the credentials the engine is meant to use.
    for (name, _) in std::env::vars() {
        let upper = name.to_uppercase();
        if upper.starts_with("ANTHROPIC_") || upper.starts_with("CLAUDE") || upper.contains("OAUTH") {
            command.env_remove(name);
        }
    }

    #[cfg(debug_assertions)]
    command.env("SHU_DATA_DIR", root.join(".dev/data"));

    #[cfg(not(debug_assertions))]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command.spawn()
}

/// Keeps the engine running. A restarted engine comes up stopped, so a crash can never
/// switch the bot back on by itself. Gives up after repeated quick failures.
pub fn supervise(connection: Connection, app: AppHandle) {
    thread::spawn(move || {
        let mut quick_failures = 0;
        loop {
            let started = Instant::now();
            match start(&connection).and_then(|mut child| child.wait()) {
                Ok(status) => eprintln!("engine exited: {status}"),
                Err(error) => eprintln!("engine failed to start: {error}"),
            }
            quick_failures = if started.elapsed() > Duration::from_secs(60) { 0 } else { quick_failures + 1 };
            if quick_failures >= MAX_QUICK_FAILURES {
                let _ = app.emit("engine-failed", ());
                return;
            }
            thread::sleep(Duration::from_secs(2));
        }
    });
}
