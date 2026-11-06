//! Runs the engine as a child process and makes sure it can't outlive the app.

use serde::Serialize;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const ALLOWED_ORIGINS: &str = "http://tauri.localhost,tauri://localhost,http://127.0.0.1:5173";
const MAX_QUICK_FAILURES: u32 = 5;

/// What the engine runs from and where its data is. A development build runs it from this
/// checkout. An installed one runs what the installer put beside the app, its own Node included,
/// and needs nothing from here. Its data and its keys live in the app's own data folder,
/// %LOCALAPPDATA%\com.shu.console, not with the program in %LOCALAPPDATA%\Shu, which an update
/// or uninstall rewrites. Uninstalling removes the data only if the owner ticks that box.
pub struct Launch {
    node: PathBuf,
    dir: PathBuf,
    script: &'static str,
    env_file: PathBuf,
    data_dir: PathBuf,
    /// Only the first engine started after Windows started the app is told so.
    at_login: bool,
}

impl Launch {
    #[cfg(debug_assertions)]
    pub fn new(_app: &AppHandle, at_login: bool) -> tauri::Result<Self> {
        let root = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.."));
        Ok(Self {
            node: PathBuf::from("node"),
            dir: root.join("packages/engine"),
            script: "src/main.ts",
            env_file: root.join("spikes/.env.local"),
            data_dir: root.join(".dev/data"),
            at_login,
        })
    }

    #[cfg(not(debug_assertions))]
    pub fn new(app: &AppHandle, at_login: bool) -> tauri::Result<Self> {
        use tauri::Manager;
        let dir = app.path().resource_dir()?.join("engine");
        let data_dir = app.path().app_local_data_dir()?;
        Ok(Self { node: dir.join("node.exe"), dir, script: "engine.mjs", env_file: data_dir.join(".env.local"), data_dir, at_login })
    }
}

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

fn start(connection: &Connection, launch: &Launch, at_login: bool) -> std::io::Result<Child> {
    let mut command = Command::new(&launch.node);
    command
        .current_dir(&launch.dir)
        .arg("--disable-warning=ExperimentalWarning")
        .arg(format!("--env-file-if-exists={}", launch.env_file.display()))
        .arg(launch.script)
        .env("SHU_ENGINE_PORT", connection.port.to_string())
        .env("SHU_ENGINE_TOKEN", &connection.token)
        .env("SHU_ALLOWED_ORIGINS", ALLOWED_ORIGINS)
        .env("SHU_DATA_DIR", &launch.data_dir);

    // A session started from inside Claude passes on its own login, which would otherwise
    // override the credentials the engine is meant to use. Nothing from outside may say the
    // app started with Windows either: only this process knows that.
    for (name, _) in std::env::vars() {
        let upper = name.to_uppercase();
        if upper.starts_with("ANTHROPIC_") || upper.starts_with("CLAUDE") || upper.contains("OAUTH") || upper == "SHU_LAUNCHED_AT_LOGIN" {
            command.env_remove(name);
        }
    }
    if at_login {
        command.env("SHU_LAUNCHED_AT_LOGIN", "1");
    }

    #[cfg(not(debug_assertions))]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command.spawn()
}

/// Keeps the engine running. A restarted engine comes up stopped, so a crash can never
/// switch the bot back on by itself: only the first one hears that the app started with
/// Windows, which may turn it on if the owner asked for that. Gives up after repeated quick
/// failures.
pub fn supervise(connection: Connection, launch: Launch, app: AppHandle) {
    thread::spawn(move || {
        let mut quick_failures = 0;
        let mut at_login = launch.at_login;
        loop {
            let started = Instant::now();
            let first = std::mem::replace(&mut at_login, false);
            match start(&connection, &launch, first).and_then(|mut child| child.wait()) {
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
