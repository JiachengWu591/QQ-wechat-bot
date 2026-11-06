import { useEffect, useRef, useState } from "react";
import { Activity, Inbox, LayoutDashboard, MessagesSquare, Sparkles, X } from "lucide-react";
import { hideWindow, quitApp, reportRunning, subscribeShell } from "./shell.ts";
import { ActivityPage } from "./pages/ActivityPage.tsx";
import { ChatPage } from "./pages/ChatPage.tsx";
import { OverviewPage } from "./pages/OverviewPage.tsx";
import { PendingPage } from "./pages/PendingPage.tsx";
import { PersonaPage } from "./pages/PersonaPage.tsx";
import { useEngine } from "./useEngine.ts";

type PageId = "overview" | "pending" | "chat" | "persona" | "activity";

const pages = [
  { id: "overview", label: "总览", icon: LayoutDashboard },
  { id: "pending", label: "待确认", icon: Inbox },
  { id: "chat", label: "聊天", icon: MessagesSquare },
  { id: "persona", label: "人设", icon: Sparkles },
  { id: "activity", label: "活动", icon: Activity },
] as const;

export function App() {
  const engine = useEngine();
  const [page, setPage] = useState<PageId>("overview");
  const running = engine.state?.running ?? false;
  const pendingCount = engine.state?.pending.length ?? 0;
  const [askingToClose, setAskingToClose] = useState(false);

  const { send, showError } = engine;
  const runningNow = useRef(running);
  runningNow.current = running;

  useEffect(() => reportRunning(running), [running]);
  useEffect(
    () =>
      subscribeShell({
        onTrayToggle: () => send({ type: runningNow.current ? "engine.stop" : "engine.start" }),
        onCloseRequested: () => setAskingToClose(true),
        onEngineFailed: () => showError("引擎反复启动失败，已停止重试。请重新打开程序。"),
      }),
    [send, showError],
  );

  return (
    <div className="app">
      <nav className="sidebar" aria-label="主导航">
        <div className="brand">
          <span className="brand-mark">枢</span>
          <span className={`status-pill ${running ? "status-on" : ""}`}>{running ? "运行中" : "已停止"}</span>
        </div>
        <ul>
          {pages.map(({ id, label, icon: Icon }) => (
            <li key={id}>
              <button type="button" className={`nav-item${page === id ? " nav-current" : ""}`} aria-current={page === id ? "page" : undefined} onClick={() => setPage(id)}>
                <Icon size={16} aria-hidden="true" />
                {label}
                {id === "pending" && pendingCount > 0 ? <span className="nav-badge">{pendingCount}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <main className="content">
        {!engine.connected ? <div className="banner banner-warn">正在连接引擎…</div> : null}
        {engine.error ? (
          <div className="banner banner-error" role="alert">
            <span>{engine.error}</span>
            <button type="button" className="icon-button" aria-label="关闭提示" onClick={engine.dismissError}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {!engine.state ? null : page === "overview" ? (
          <OverviewPage engine={engine} state={engine.state} onOpenActivity={() => setPage("activity")} />
        ) : page === "pending" ? (
          <PendingPage engine={engine} state={engine.state} />
        ) : page === "chat" ? (
          <ChatPage engine={engine} state={engine.state} />
        ) : page === "persona" ? (
          <PersonaPage engine={engine} state={engine.state} />
        ) : (
          <ActivityPage entries={engine.activity} />
        )}
      </main>

      {askingToClose ? (
        <div className="dialog-backdrop">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="close-title">
            <h2 id="close-title">bot 还在运行</h2>
            <p>放到托盘后，它会继续收发消息。退出会立刻停止所有任务。</p>
            <div className="actions">
              <button
                type="button"
                className="button button-primary"
                autoFocus
                onClick={() => {
                  setAskingToClose(false);
                  hideWindow();
                }}
              >
                放到托盘
              </button>
              <button type="button" className="button" onClick={quitApp}>
                停止并退出
              </button>
              <button type="button" className="button" onClick={() => setAskingToClose(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
