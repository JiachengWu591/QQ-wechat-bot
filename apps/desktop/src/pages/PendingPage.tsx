import { useState } from "react";
import { WECHAT_WORK_CHANNEL_ID, workMessageProblem, type EngineState, type PendingReply } from "@shu/protocol";
import { formatCost, formatTime, tierLabels } from "../ui.tsx";
import type { EngineApi } from "../useEngine.ts";

function PendingCard({ reply, engine, state }: { reply: PendingReply; engine: EngineApi; state: EngineState }) {
  const [draft, setDraft] = useState(reply.draft);
  const [copied, setCopied] = useState(false);
  const trimmed = draft.trim();
  const { running, workbench } = state;
  const isWorkGroup = reply.channelId === WECHAT_WORK_CHANNEL_ID;
  const sending = isWorkGroup && Boolean(workbench?.sending);
  const switchedOff = isWorkGroup && (!running || !workbench?.enabled);
  const problem = isWorkGroup ? workMessageProblem(trimmed) : null;
  const uncertain = Boolean(reply.sendUncertain);
  const approve = () =>
    engine.send({
      type: "pending.approve",
      pendingId: reply.id,
      ...(trimmed === reply.draft ? {} : { text: trimmed }),
      ...(uncertain ? { confirmedUnsent: true } : {}),
    });

  async function copy() {
    await navigator.clipboard.writeText(trimmed);
    setCopied(true);
  }

  function workGroupNote(): string {
    if (sending) return "正在发送，先不要碰键盘和鼠标。";
    if (switchedOff) return "总闸和微信工作群开关都打开后才能发送。";
    if (problem) return problem;
    return "发送时会短暂切到微信，你约 3 秒没操作后开始，发完切回来。发出去就收不回了。";
  }

  return (
    <article className="panel pending">
      <header className="pending-header">
        <strong>{reply.conversationTitle}</strong>
        <span className="panel-meta">
          {formatTime(reply.createdAt)} · {isWorkGroup ? "微信工作群" : `${tierLabels[reply.tier]}权限`} · {formatCost(reply.costUsd)}
        </span>
      </header>
      <blockquote>
        <span className="pending-sender">{reply.triggerSender}</span>
        {reply.triggerText}
      </blockquote>
      {uncertain ? <p className="form-error">上一次发送不确定有没有发出去。请先看一下“{reply.conversationTitle}”里有没有这条，发出去了就点忽略。</p> : null}
      <label className="field-label" htmlFor={`draft-${reply.id}`}>
        回复草稿
      </label>
      <textarea id={`draft-${reply.id}`} rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} />
      {isWorkGroup ? (
        <div className="actions">
          <button type="button" className="button button-primary" disabled={switchedOff || sending || problem !== null} onClick={approve}>
            {uncertain ? "确认没发出去，再发一次" : `发送到“${reply.conversationTitle}”`}
          </button>
          <button type="button" className="button" disabled={!trimmed} onClick={() => void copy()}>
            {copied ? "已复制" : "复制草稿"}
          </button>
          <button type="button" className="button" disabled={sending} onClick={() => engine.send({ type: "pending.reject", pendingId: reply.id })}>
            忽略
          </button>
          <span className="panel-meta">{workGroupNote()}</span>
        </div>
      ) : (
        <div className="actions">
          <button type="button" className="button button-primary" disabled={!running || !trimmed} onClick={approve}>
            确认发送
          </button>
          <button type="button" className="button" onClick={() => engine.send({ type: "pending.reject", pendingId: reply.id })}>
            忽略
          </button>
          {!running ? <span className="panel-meta">总闸关闭时不能发送</span> : null}
        </div>
      )}
    </article>
  );
}

export function PendingPage({ engine, state }: { engine: EngineApi; state: EngineState }) {
  return (
    <>
      <h1 className="page-title">待确认</h1>
      {state.pending.length ? (
        state.pending.map((reply) => <PendingCard key={reply.id} reply={reply} engine={engine} state={state} />)
      ) : (
        <p className="empty">没有等你确认的回复。设为“确认后发送”的聊天和微信工作群的草稿，会先出现在这里。</p>
      )}
    </>
  );
}
