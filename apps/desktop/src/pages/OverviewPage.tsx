import { useState } from "react";
import { Pencil } from "lucide-react";
import { modelOptions, type Autonomy, type ChannelStatus, type ChannelView, type ConversationView, type EngineState, type ModelId } from "@shu/protocol";
import { ActivityRow, autonomyLabels, formatCost, Switch } from "../ui.tsx";
import type { EngineApi } from "../useEngine.ts";
import { AccessPanel } from "./AccessPanel.tsx";
import { LoginPanel } from "./LoginPanel.tsx";
import { WorkbenchPanel } from "./WorkbenchPanel.tsx";

const autonomyOptions: Autonomy[] = ["notify", "confirm", "auto"];

const statusLabels: Record<ChannelStatus["state"], string> = {
  stopped: "未连接",
  connecting: "连接中",
  connected: "已连接",
  error: "连接失败",
  "needs-login": "未登录",
};

function Spending({ label, usedUsd, limitUsd }: { label: string; usedUsd: number; limitUsd: number }) {
  const usedPercent = Math.min(100, (usedUsd / limitUsd) * 100);
  return (
    <div className="spending">
      <p className="meter-label">
        <span>{label}</span>
        <span>
          {formatCost(usedUsd)} / ${limitUsd}
        </span>
      </p>
      <div className="meter" role="img" aria-label={`${label}今日已用 ${formatCost(usedUsd)}，上限 $${limitUsd}`}>
        <span className={`meter-fill${usedPercent >= 100 ? " meter-full" : ""}`} style={{ width: `${usedPercent}%` }} />
      </div>
    </div>
  );
}

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
  const { todayUsd, dailyLimitUsd, ownerTodayUsd, ownerDailyLimitUsd, searchesToday, searchLimit } = state.usage;
  // A channel waiting to be signed in does nothing until someone acts, so it goes up top.
  const needsAttention = (channel: ChannelView) => channel.canLogin && (channel.login !== undefined || channel.status.state === "needs-login");

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

      {state.channels.filter(needsAttention).map((channel) => (
        <section className="panel panel-attention" key={channel.id}>
          <h2>登录{channel.name}</h2>
          <LoginPanel engine={engine} channel={channel} running={state.running} />
        </section>
      ))}

      <section className="panel">
        <header className="panel-header">
          <h2>今日费用</h2>
          {state.brain.ready ? (
            <label className="model-picker">
              模型
              <select value={state.brain.model} onChange={(event) => engine.send({ type: "brain.setModel", model: event.target.value as ModelId })}>
                {modelOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}（{option.note}）
                  </option>
                ))}
                {/* A model set some other way still has to show up as what's in use. */}
                {modelOptions.some((option) => option.id === state.brain.model) ? null : <option value={state.brain.model}>{state.brain.model}</option>}
              </select>
            </label>
          ) : null}
        </header>
        <Spending label="群聊" usedUsd={todayUsd} limitUsd={dailyLimitUsd} />
        <Spending label="我的工作" usedUsd={ownerTodayUsd} limitUsd={ownerDailyLimitUsd} />
        <p className="panel-meta">
          群友搜索 {searchesToday} / {searchLimit} 次
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
          {channel.canLogin && !needsAttention(channel) ? <LoginPanel engine={engine} channel={channel} running={state.running} /> : null}
          {channel.conversations.length ? (
            <ul className="rows">
              {channel.conversations.map((conversation) => (
                <ConversationRow key={conversation.id} engine={engine} channel={channel} conversation={conversation} />
              ))}
            </ul>
          ) : (
            <p className="empty">
              {channel.canLogin
                ? "还没有聊天。登录后给机器人发一条消息，聊天会出现在这里。"
                : "还没有聊天。在群里发一条消息后，群会出现在这里，默认关闭，打开后才会回复。"}
            </p>
          )}
        </section>
      ))}

      <WorkbenchPanel engine={engine} state={state} />

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
