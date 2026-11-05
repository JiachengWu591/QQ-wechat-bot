import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { ChannelView } from "@shu/protocol";
import type { EngineApi } from "../useEngine.ts";

// Dark modules on white whatever the theme, because that's what a phone camera expects.
function QrCode({ content }: { content: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!canvas.current) return;
    setFailed(false);
    QRCode.toCanvas(canvas.current, content, { width: 208, margin: 2 }).catch(() => setFailed(true));
    // In a short window it would otherwise appear below the edge.
    canvas.current.scrollIntoView({ block: "nearest" });
  }, [content]);

  if (failed) return <p className="banner banner-error">二维码画不出来，请重新登录。</p>;
  return <canvas ref={canvas} className="qr-code" role="img" aria-label="登录二维码" />;
}

function VerifyForm({ engine, channel }: { engine: EngineApi; channel: ChannelView }) {
  const [code, setCode] = useState("");

  return (
    <form
      className="actions"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = code.trim();
        if (!trimmed) return;
        engine.send({ type: "channel.loginCode", channelId: channel.id, code: trimmed });
        setCode("");
      }}
    >
      <input
        className="title-input"
        aria-label="手机上显示的数字"
        autoFocus
        inputMode="numeric"
        maxLength={20}
        value={code}
        onChange={(event) => setCode(event.target.value)}
      />
      <button type="submit" className="button button-primary" disabled={!code.trim()}>
        确认
      </button>
    </form>
  );
}

export function LoginPanel({ engine, channel, running }: { engine: EngineApi; channel: ChannelView; running: boolean }) {
  const { login, status } = channel;
  const begin = () => engine.send({ type: "channel.login", channelId: channel.id });

  if (login?.state === "qr") {
    return (
      <div className="pairing login">
        <QrCode content={login.qrContent} />
        <div>
          <p>用要绑定的微信扫码，并在手机上确认。</p>
          <p className="panel-meta">扫码的这个微信会成为主人。过期后会自动换新码。</p>
        </div>
      </div>
    );
  }
  if (login?.state === "scanned") {
    return (
      <div className="pairing">
        <p>已扫码，请在手机上确认。</p>
      </div>
    );
  }
  if (login?.state === "verify") {
    return (
      <div className="pairing">
        <p>输入手机上显示的数字：</p>
        <VerifyForm engine={engine} channel={channel} />
      </div>
    );
  }
  if (login?.state === "failed") {
    return (
      <div className="banner banner-error">
        <span>登录失败：{login.message}</span>
        <button type="button" className="button" onClick={begin}>
          重试
        </button>
      </div>
    );
  }

  if (status.state === "needs-login") {
    return (
      <div className="actions">
        <button type="button" className="button button-primary" disabled={!running || !channel.enabled} onClick={begin}>
          扫码登录
        </button>
      </div>
    );
  }
  if (status.state === "connected") {
    return (
      <div className="actions">
        <button type="button" className="link-button" onClick={() => engine.send({ type: "channel.logout", channelId: channel.id })}>
          退出登录
        </button>
      </div>
    );
  }
  return null;
}
