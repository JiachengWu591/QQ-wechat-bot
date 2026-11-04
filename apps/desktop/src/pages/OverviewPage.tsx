import { useState } from "react";
import { Pencil } from "lucide-react";
import type { Autonomy, ChannelStatus, ChannelView, ConversationView, EngineState } from "@shu/protocol";
import { ActivityRow, autonomyLabels, formatCost, Switch } from "../ui.tsx";
import type { EngineApi } from "../useEngine.ts";
import { AccessPanel } from "./AccessPanel.tsx";

const autonomyOptions: Autonomy[] = ["notify", "confirm", "auto"];

const statusLabels: Record<ChannelStatus["state"], string> = {
  stopped: "未连接",
  connecting: "连接中",
  connected: "已连接",
  error: "连接失败",
};

function ConversationRow({ engine, channel, conversation }: { engine: EngineApi; channel: ChannelView; conversation: ConversationView }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conversation.title);

  function saveTitle() {
    setEditing(false);
    const trimmed = title.trim();
    if (trimmed && trimmed !== conversation.title) {
      engine.send({ type: "conversation.rename", channelId: channel.id, conversationId: conversation.id, title: trimmed });
    } else {
      setTitle(conversation.title);
    }
  }

  return (
    <li className="row">
      <span className="row-title">
        {editing ? (
          <input
            className="title-input"
            aria-label="聊天名称"
            autoFocus
            maxLength={60}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={saveTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveTitle();
              if (event.key === "Escape") {
                setTitle(conversation.title);
                setEditing(false);
              }
            }}
          />
        ) : (
          <>
            <span className="row-name">{conversation.title}</span>
            <button type="button" className="icon-button" aria-label={`重命名 ${conversation.title}`} title="重命名" onClick={() => setEditing(true)}>
              <Pencil size={12} aria-hidden="true" />
            </button>
          </>
        )}
        <span className="row-tag">{conversation.kind === "group" ? "群聊" : "私聊"}</span>
      </span>
      <label className="select-label">
        <span className="visually-hidden">{conversation.title}的回复方式</span>
        <select
          value={conversation.autonomy}
          onChange={(event) =>
            engine.send({
              type: "conversation.setAutonomy",
              channelId: channel.id,
              conversationId: conversation.id,
              autonomy: event.target.value as Autonomy,
            })
          }
        >
          {autonomyOptions.map((option) => (
            <option key={option} value={option}>
              {autonomyLabels[option]}
            </option>
          ))}
        </select>
      </label>
      <Switch
        checked={conversation.enabled}
        label={`${conversation.title}开关`}
        onChange={(enabled) => engine.send({ type: "conversation.setEnabled", channelId: channel.id, conversationId: conversation.id, enabled })}
      />
    </li>
  );
}

export function OverviewPage({ engine, state, onOpenActivity }: { engine: EngineApi; state: EngineState; onOpenActivity(): void }) {
  const { todayUsd, dailyLimitUsd, searchesToday, searchLimit } = state.usage;
  const usedPercent = Math.min(100, (todayUsd / dailyLimitUsd) * 100);

  return (
    <>
      <section className={`master ${state.running ? "master-on" : ""}`}>
        <Switch
          large
          checked={state.running}
          label="总闸"
          onChange={(on) => engine.send({ type: on ? "engine.start" : "engine.stop" })}
        />
        <div>
          <h1>{state.running ? "正在运行" : "已停止"}</h1>
          <p>{state.running ? "关闭后立刻停止发送，进行中的任务也会中止。" : "打开后只处理从现在开始的新消息。"}</p>
        </div>
      </section>

      {!state.brain.ready ? (
        <div className="banner banner-warn">还没有配置 API key，bot 收到消息也无法回复。</div>
      ) : null}

      <section className="panel">
        <header className="panel-header">
          <h2>今日费用</h2>
          <span className="panel-meta">{state.brain.model}</span>
        </header>
        <div className="meter" role="img" aria-label={`今日已用 ${formatCost(todayUsd)}，上限 $${dailyLimitUsd}`}>
          <span className={`meter-fill${usedPercent >= 100 ? " meter-full" : ""}`} style={{ width: `${usedPercent}%` }} />
        </div>
        <p className="meter-label">
          {formatCost(todayUsd)} / ${dailyLimitUsd} · 群友搜索 {searchesToday} / {searchLimit} 次
        </p>
      </section>

      {state.channels.map((channel) => (
        <section className="panel" key={channel.id}>
          <header className="panel-header">
            <h2 className="channel-title">
              {channel.name}
              <span className={`channel-status channel-status-${channel.status.state}`}>
                <span className="dot" />
                {statusLabels[channel.status.state]}
              </span>
            </h2>
            <Switch
              checked={channel.enabled}
              label={`${channel.name}开关`}
              onChange={(enabled) => engine.send({ type: "channel.setEnabled", channelId: channel.id, enabled })}
            />
          </header>
          {channel.status.detail ? <p className="panel-meta">{channel.status.detail}</p> : null}
          {channel.conversations.length ? (
            <ul className="rows">
              {channel.conversations.map((conversation) => (
                <ConversationRow key={conversation.id} engine={engine} channel={channel} conversation={conversation} />
              ))}
            </ul>
          ) : (
            <p className="empty">还没有聊天。在群里发一条消息后，群会出现在这里，默认关闭，打开后才会回复。</p>
          )}
        </section>
      ))}

      <AccessPanel engine={engine} state={state} />

      <section className="panel">
        <header className="panel-header">
          <h2>最近活动</h2>
          <button type="button" className="link-button" onClick={onOpenActivity}>
            查看全部
          </button>
        </header>
        {engine.activity.length ? (
          <ul className="activity-list">
            {engine.activity.slice(0, 6).map((entry) => (
              <ActivityRow key={entry.id} entry={entry} />
            ))}
          </ul>
        ) : (
          <p className="empty">打开总闸后，这里会显示 bot 做的每件事。</p>
        )}
      </section>
    </>
  );
}
