import { useEffect, useState } from "react";
import type { EngineState } from "@shu/protocol";
import { autostartState, setAutostart, type Autostart } from "../shell.ts";
import { Switch } from "../ui.tsx";
import type { EngineApi } from "../useEngine.ts";

export function StartupPanel({ engine, state }: { engine: EngineApi; state: EngineState }) {
  const [autostart, setAutostartState] = useState<Autostart | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void autostartState().then(setAutostartState, (reason: unknown) => setError(String(reason)));
  }, []);

  if (!autostart) return error ? <p className="form-error">{error}</p> : null;

  async function toggle(enabled: boolean) {
    setError(null);
    try {
      setAutostartState(await setAutostart(enabled));
    } catch (reason) {
      setError(String(reason));
    }
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>开机启动</h2>
        {autostart.available ? <Switch checked={autostart.enabled} label="开机启动" onChange={(enabled) => void toggle(enabled)} /> : null}
      </header>
      {!autostart.available ? (
        <p className="panel-meta">开发版不能设开机启动，装好的版本才可以。</p>
      ) : autostart.enabled ? (
        <>
          <p className="panel-meta">登录 Windows 后自动启动，窗口不弹出来，在托盘里。</p>
          <ul className="rows">
            <li className="row">
              <span className="row-title">
                <span className="row-name">启动后自动打开总闸</span>
              </span>
              <Switch checked={state.runAtLogin} label="启动后自动打开总闸" onChange={(enabled) => engine.send({ type: "engine.setRunAtLogin", enabled })} />
            </li>
          </ul>
          <p className="panel-meta">
            {state.runAtLogin ? "开机后 bot 会自己上线。" : "开机后总闸是关的，要你从托盘或这里打开。"}引擎出错重启后，总闸都是关的。
          </p>
        </>
      ) : (
        <p className="panel-meta">关着。打开后，登录 Windows 时自动启动，窗口不弹出来，在托盘里。</p>
      )}
      {error ? <p className="form-error">{error}</p> : null}
    </section>
  );
}
