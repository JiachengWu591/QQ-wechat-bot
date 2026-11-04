import { useState } from "react";
import type { EngineState, PendingReply } from "@shu/protocol";
import { formatCost, formatTime, tierLabels } from "../ui.tsx";
import type { EngineApi } from "../useEngine.ts";

function PendingCard({ reply, engine, running }: { reply: PendingReply; engine: EngineApi; running: boolean }) {
  const [draft, setDraft] = useState(reply.draft);
  const trimmed = draft.trim();

  return (
    <article className="panel pending">
      <header className="pending-header">
        <strong>{reply.conversationTitle}</strong>
        <span className="panel-meta">
          {formatTime(reply.createdAt)} · {tierLabels[reply.tier]}权限 · {formatCost(reply.costUsd)}
        </span>
      </header>
      <blockquote>
        <span className="pending-sender">{reply.triggerSender}</span>
        {reply.triggerText}
      </blockquote>
      <label className="field-label" htmlFor={`draft-${reply.id}`}>
        回复草稿
      </label>
      <textarea id={`draft-${reply.id}`} rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} />
      <div className="actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!running || !trimmed}
          onClick={() => engine.send({ type: "pending.approve", pendingId: reply.id, ...(trimmed === reply.draft ? {} : { text: trimmed }) })}
        >
          确认发送
        </button>
        <button type="button" className="button" onClick={() => engine.send({ type: "pending.reject", pendingId: reply.id })}>
          忽略
        </button>
        {!running ? <span className="panel-meta">总闸关闭时不能发送</span> : null}
      </div>
    </article>
  );
}

export function PendingPage({ engine, state }: { engine: EngineApi; state: EngineState }) {
  return (
    <>
      <h1 className="page-title">待确认</h1>
      {state.pending.length ? (
        state.pending.map((reply) => <PendingCard key={reply.id} reply={reply} engine={engine} running={state.running} />)
      ) : (
        <p className="empty">没有等你确认的回复。设为“确认后发送”的聊天，回复会先出现在这里。</p>
      )}
    </>
  );
}
