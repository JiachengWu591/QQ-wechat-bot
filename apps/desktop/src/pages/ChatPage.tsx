import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Send } from "lucide-react";
import { MAX_PERSONA_EXAMPLE_CHARS, type ActivityEntry, type ChatLine, type EngineState } from "@shu/protocol";
import { formatTime, tierLabels } from "../ui.tsx";
import type { EngineApi } from "../useEngine.ts";

type TimelineItem = { kind: "line"; at: number; line: ChatLine } | { kind: "notice"; at: number; entry: ActivityEntry };

const SIM_CHANNEL = "sim";

const clip = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, MAX_PERSONA_EXAMPLE_CHARS);

export function ChatPage({ engine, state }: { engine: EngineApi; state: EngineState }) {
  const conversations = state.channels.flatMap((channel) =>
    channel.conversations.map((conversation) => ({
      ...conversation,
      channelId: channel.id,
      channelName: channel.name,
      personaInOwnerChat: Boolean(channel.personaInOwnerChat),
      key: `${channel.id}:${conversation.id}`,
    })),
  );
  const [selected, setSelected] = useState(conversations.find((entry) => entry.channelId === SIM_CHANNEL)?.key ?? conversations[0]?.key ?? "");
  const [senderId, setSenderId] = useState(state.simSenders.find((sender) => sender.tier === "member")?.id ?? "");
  const [mention, setMention] = useState(true);
  const [text, setText] = useState("");
  // A bot reply being rewritten into what it should have said, to keep as a persona example.
  const [fixing, setFixing] = useState<{ lineId: string; text: string } | null>(null);
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
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

  // What each bot reply answered: the message just before it.
  const answered = useMemo(() => {
    const map = new Map<string, ChatLine>();
    let last: ChatLine | undefined;
    for (const item of timeline) {
      if (item.kind !== "line") continue;
      if (item.line.direction === "in") last = item.line;
      else if (last) map.set(item.line.id, last);
    }
    return map;
  }, [timeline]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [timeline.length, selected]);

  // The owner's private chat on WeChat is for work, which the persona never applies to.
  const canFix = (line: ChatLine) => {
    const asked = answered.get(line.id);
    return Boolean(asked) && !(conversation?.kind === "dm" && asked?.tier === "owner" && !conversation.personaInOwnerChat);
  };

  function keep(line: ChatLine, reply: string) {
    const asked = answered.get(line.id);
    if (!asked || !clip(asked.text) || !clip(reply)) return;
    engine.send({ type: "persona.addExample", example: { said: clip(asked.text), reply: clip(reply) } });
    setKept((ids) => new Set(ids).add(line.id));
    setFixing(null);
  }

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
                {fixing?.lineId === item.line.id ? (
                  <div className="bubble-fix">
                    <label className="visually-hidden" htmlFor={`fix-${item.line.id}`}>
                      改成你想要的回复
                    </label>
                    <textarea
                      id={`fix-${item.line.id}`}
                      rows={2}
                      maxLength={MAX_PERSONA_EXAMPLE_CHARS}
                      autoFocus
                      value={fixing.text}
                      onChange={(event) => setFixing({ lineId: item.line.id, text: event.target.value })}
                    />
                    <div className="actions">
                      <button type="button" className="button button-primary" disabled={!clip(fixing.text)} onClick={() => keep(item.line, fixing.text)}>
                        存为示例
                      </button>
                      <button type="button" className="button" onClick={() => setFixing(null)}>
                        取消
                      </button>
                    </div>
                    <p className="panel-meta">
                      会和上一条“{clip(answered.get(item.line.id)?.text ?? "")}”配成一组，加到人设的示例里。
                      {state.persona.mode === "off" ? "人设现在是关的，要在“人设”页打开才生效。" : ""}
                    </p>
                  </div>
                ) : item.line.direction === "out" && canFix(item.line) ? (
                  <button type="button" className="link-button bubble-fix-link" disabled={kept.has(item.line.id)} onClick={() => setFixing({ lineId: item.line.id, text: item.line.text })}>
                    {kept.has(item.line.id) ? "已存为示例" : "改成这样…"}
                  </button>
                ) : null}
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
