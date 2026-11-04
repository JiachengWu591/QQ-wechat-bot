import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import type { EngineState, GrantedTier } from "@shu/protocol";
import { tierLabels } from "../ui.tsx";
import type { EngineApi } from "../useEngine.ts";

// The simulated channel has built-in identities, so only real platforms can be paired.
const realChannels = (state: EngineState) => state.channels.filter((channel) => channel.id !== "sim");

export function AccessPanel({ engine, state }: { engine: EngineApi; state: EngineState }) {
  const channels = realChannels(state);
  const { pairing } = state;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  if (channels.length === 0) return null;
  const channelName = (id: string) => state.channels.find((channel) => channel.id === id)?.name ?? id;
  const minutesLeft = pairing ? Math.ceil((pairing.expiresAt - now) / 60_000) : 0;
  const pair = (channelId: string, tier: GrantedTier) => engine.send({ type: "pairing.start", channelId, tier });

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>身份</h2>
        <span className="panel-meta">其他人都按群友处理，不能私聊，也不能用本机工具</span>
      </header>

      {state.access.length ? (
        <ul className="rows">
          {state.access.map((entry) => (
            <li className="row" key={`${entry.channelId}:${entry.senderId}`}>
              <span className="row-title">
                {entry.name}
                <span className={`tier tier-${entry.tier}`}>{tierLabels[entry.tier]}</span>
                <span className="row-tag">{channelName(entry.channelId)}</span>
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={`移除 ${entry.name}`}
                title="移除"
                onClick={() => engine.send({ type: "access.remove", channelId: entry.channelId, senderId: entry.senderId })}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">还没有绑定主人。绑定之后，你才能私聊机器人。</p>
      )}

      {pairing && minutesLeft > 0 ? (
        <div className="pairing">
          <p>
            用要绑定的账号，在 {channelName(pairing.channelId)} 里私聊机器人，发送这个配对码：
          </p>
          <strong className="pairing-code">{pairing.code}</strong>
          <div className="actions">
            <span className="panel-meta">
              绑定为{tierLabels[pairing.tier]} · {minutesLeft} 分钟内有效 · 不要发到群里
            </span>
            <button type="button" className="button" onClick={() => engine.send({ type: "pairing.cancel" })}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          {channels.map((channel) => (
            <span className="actions" key={channel.id}>
              <button type="button" className="button" onClick={() => pair(channel.id, "owner")}>
                绑定主人（{channel.name}）
              </button>
              <button type="button" className="button" onClick={() => pair(channel.id, "trusted")}>
                绑定信任的人
              </button>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
