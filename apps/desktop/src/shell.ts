// What the desktop shell adds on top of the page. In a plain browser these do nothing.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const inShell = isTauri();

export async function engineUrl(): Promise<string> {
  const { port, token } = inShell
    ? await invoke<{ port: number; token: string }>("engine_connection")
    : { port: import.meta.env.VITE_ENGINE_PORT ?? 47821, token: import.meta.env.VITE_ENGINE_TOKEN ?? "" };
  return `ws://127.0.0.1:${port}/?token=${token}`;
}

export function reportRunning(running: boolean) {
  if (inShell) void invoke("set_running", { running });
}

export function hideWindow() {
  if (inShell) void invoke("hide_window");
}

export function quitApp() {
  if (inShell) void invoke("quit_app");
}

export function subscribeShell(handlers: { onTrayToggle(): void; onCloseRequested(): void; onEngineFailed(): void }): () => void {
  if (!inShell) return () => {};
  const subscriptions = [
    listen("tray-toggle", handlers.onTrayToggle),
    listen("close-requested", handlers.onCloseRequested),
    listen("engine-failed", handlers.onEngineFailed),
  ];
  return () => {
    for (const subscription of subscriptions) void subscription.then((unlisten) => unlisten());
  };
}
