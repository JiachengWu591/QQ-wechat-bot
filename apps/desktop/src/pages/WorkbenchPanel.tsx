import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { EngineState, WorkbenchStatus } from "@shu/protocol";
import { Switch } from "../ui.tsx";
import type { EngineApi } from "../useEngine.ts";

const statusLabels: Record<WorkbenchStatus["state"], string> = {
  off: "未读取",
  scanning: "读取中",
  paused: "已暂停",
  error: "读取失败",
};

// The look of the channel with the closest meaning.
const statusStyles: Record<WorkbenchStatus["state"], string> = {
  off: "stopped",
  scanning: "connected",
  paused: "connecting",
  error: "error",
};

export function WorkbenchPanel({ engine, state }: { engine: EngineApi; state: EngineState }) {
  const [name, setName] = useState("");
  const { workbench, running } = state;
  if (!workbench) return null;
  const { enabled, status, allowedGroups, intervalSeconds } = workbench;

  function allow() {
    const trimmed = name.trim();
    if (!trimmed) return;
    engine.send({ type: "workbench.allowGroup", name: trimmed });
    setName("");
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <h2 className="channel-title">
          微信工作群
          <span className={`channel-status channel-status-${statusStyles[status.state]}`}>
            <span className="dot" />
            {statusLabels[status.state]}
          </span>
        </h2>
        <Switch checked={enabled} label="读取微信工作群开关" onChange={(on) => engine.send({ type: "workbench.setEnabled", enabled: on })} />
      </header>

      <p className="panel-meta">
        每 {intervalSeconds} 秒看一次微信窗口的左栏，找“有人@我”，然后提醒你。左栏只在这台电脑上识别，不发给 Claude。不会自动往群里发消息，只有你在“待确认”里点了发送才会发。微信不能最小化，盖在别的窗口后面没关系。
      </p>
      {enabled && !running ? <p className="panel-meta">打开总闸后开始读取。</p> : null}
      {status.detail ? <p className={status.state === "error" ? "form-error" : "panel-meta"}>{status.detail}</p> : null}

      <h3 className="subheading">允许的群</h3>
      <p className="panel-meta">这里的群有人 @ 你时，会被点开并标成已读，聊天区截图会发给 Claude 读内容并写回复草稿，费用算在“我的工作”里。其他群只提醒，不会被点开。</p>
      {allowedGroups.length ? (
        <ul className="rows">
          {allowedGroups.map((group) => (
            <li className="row" key={group}>
              <span className="row-title">
                <span className="row-name">{group}</span>
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={`移除 ${group}`}
                title="移除"
                onClick={() => engine.send({ type: "workbench.removeGroup", name: group })}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">还没有。</p>
      )}
      <form
        className="group-form"
        onSubmit={(event) => {
          event.preventDefault();
          allow();
        }}
      >
        <input className="title-input" aria-label="要允许的群名" placeholder="群名，要和微信里完全一样" maxLength={60} value={name} onChange={(event) => setName(event.target.value)} />
        <button type="submit" className="button" disabled={!name.trim()}>
          允许
        </button>
      </form>
    </section>
  );
}
