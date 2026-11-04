import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Send } from "lucide-react";
import type { ActivityEntry, ChatLine, EngineState } from "@shu/protocol";
import { formatTime, tierLabels } from "../ui.tsx";
import type { EngineApi } from "../useEngine.ts";

type TimelineItem = { kind: "line"; at: number; line: ChatLine } | { kind: "notice"; at: number; entry: ActivityEntry };

const SIM_CHANNEL = "sim";

export function ChatPage({ engine, state }: { engine: EngineApi; state: EngineState }) {
  const conversations = state.channels.flatMap((channel) =>
    channel.conversations.map((conversation) => ({ ...conversation, channelId: channel.id, channelName: channel.name, key: `${channel.id}:${conversation.id}` })),
  );
  const [selected, setSelected] = useState(conversations.find((entry) => entry.channelId === SIM_CHANNEL)?.key ?? conversations[0]?.key ?? "");
  const [senderId, setSenderId] = useState(state.simSenders.find((sender) => sender.tier === "member")?.id ?? "");
  const [mention, setMention] = useState(true);
  const [text, setText] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  const conversation = conversations.find((entry) => entry.key === selected);
  const isSim = conversation?.channelId === SIM_CHANNEL;
  const isGroup = conversation?.kind === "group";

  // Blocked and failed events appear in the conversation, so the effect of the switches
  // and permissions shows up right where the message was sent.
  const timeline = useMemo<TimelineItem[]>(() => {
    if (!conversation) return [];
    const lines: TimelineItem[] = engine.chat
      .filter((line) => line.channelId === conversation.channelId && line.conversationId === conversation.id)
      .map((line) => ({ kind: "line", at: line.at, line }));
    const notices: TimelineItem[] = engine.activity
      .filter((entry) => entry.conversationTitle === conversation.title && (entry.level === "blocked" || entry.level === "error"))
      .map((entry) => ({ kind: "notice", at: entry.at, entry }));
    return [...lines, ...notices].sort((a, b) => a.at - b.at);
  }, [engine.chat, engine.activity, conversation?.channelId, conversation?.id, conversation?.title]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [timeline.length, selected]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const body = text.trim();
    if (!body || !conversation) return;
    engine.send({ type: "sim.send", conversationId: conversation.id, senderId, text: body, mentionsBot: isGroup ? mention : true });
    setText("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="chat">
      <aside className="chat-list" aria-label="聊天列表">
        <h1 className="page-title">聊天</h1>
        {state.channels.map((channel) =>
          channel.conversations.length ? (
            <div key={channel.id}>
              <h2 className="chat-group">{channel.name}</h2>
              <ul>
                {channel.conversations.map((entry) => {
                  const key = `${channel.id}:${entry.id}`;
                  return (
                    <li key={key}>
                      <button type="button" className={`chat-item${key === selected ? " chat-item-current" : ""}`} onClick={() => setSelected(key)}>
                        <span className="chat-item-title">{entry.title}</span>
                        <span className="row-tag">{entry.kind === "group" ? "群聊" : "私聊"}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null,
        )}
        <p className="chat-hint">模拟聊天不经过真实账号，但回复同样调用 Claude 并计费。</p>
      </aside>

      <section className="chat-main" aria-label={conversation?.title}>
        <div className="chat-log" role="log">
          {timeline.length === 0 ? (
            <p className="empty">{isSim ? "选一个身份发条消息试试，也可以让群友要求 bot 读取电脑上的文件。" : "这里会显示这个聊天里 bot 收到和发出的消息。"}</p>
          ) : null}
          {timeline.map((item) =>
            item.kind === "notice" ? (
              <p key={`notice-${item.entry.id}`} className={`notice notice-${item.entry.level}`}>
                {item.entry.summary}
              </p>
            ) : (
              <div key={item.line.id} className={`bubble-row${item.line.direction === "out" ? " bubble-row-bot" : ""}`}>
                <div className="bubble-meta">
                  <strong>{item.line.senderName}</strong>
                  {item.line.direction === "in" ? <span className={`tier tier-${item.line.tier}`}>{tierLabels[item.line.tier]}</span> : null}
                  <time>{formatTime(item.line.at)}</time>
                </div>
                <div className="bubble">{item.line.text}</div>
              </div>
            ),
          )}
          <div ref={bottom} />
        </div>

        {isSim ? (
          <form className="composer" onSubmit={submit}>
            <div className="composer-options">
              <label>
                以谁的身份
                <select value={senderId} onChange={(event) => setSenderId(event.target.value)}>
                  {state.simSenders.map((sender) => (
                    <option key={sender.id} value={sender.id}>
                      {sender.name}（{tierLabels[sender.tier]}）
                    </option>
                  ))}
                  <option value="sim-stranger">陌生人（不在名单）</option>
                </select>
              </label>
              {isGroup ? (
                <label className="check">
                  <input type="checkbox" checked={mention} onChange={(event) => setMention(event.target.checked)} />@ 机器人
                </label>
              ) : null}
            </div>
            <div className="composer-input">
              <label htmlFor="chat-input" className="visually-hidden">
                消息内容
              </label>
              <textarea
                id="chat-input"
                rows={2}
                placeholder="输入消息，回车发送，Shift+回车换行"
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onKeyDown}
              />
              <button type="submit" className="button button-primary" disabled={!text.trim()}>
                <Send size={14} aria-hidden="true" />
                发送
              </button>
            </div>
          </form>
        ) : null}
      </section>
    </div>
  );
}
