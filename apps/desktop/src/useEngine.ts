import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityEntry, ChatLine, Command, EngineState, ServerEvent } from "@shu/protocol";
import { engineUrl } from "./shell.ts";

const KEEP_ACTIVITY = 200;
const KEEP_CHAT = 500;

export type EngineApi = {
  connected: boolean;
  state: EngineState | null;
  activity: ActivityEntry[];
  chat: ChatLine[];
  error: string | null;
  showError(message: string): void;
  dismissError(): void;
  send(command: Command): void;
};

export function useEngine(): EngineApi {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<EngineState | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout>;

    function open(url: string) {
      const ws = new WebSocket(url);
      socket.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) retry = setTimeout(() => open(url), 1000);
      };
      ws.onmessage = (message) => {
        const event = JSON.parse(String(message.data)) as ServerEvent;
        if (event.type === "state") setState(event.state);
        else if (event.type === "history") {
          setActivity(event.activity);
          setChat(event.chat);
        } else if (event.type === "activity") setActivity((list) => [event.entry, ...list].slice(0, KEEP_ACTIVITY));
        else if (event.type === "chat") setChat((list) => [...list, event.line].slice(-KEEP_CHAT));
        else setError(event.message);
      };
    }

    void engineUrl().then((url) => {
      if (!stopped) open(url);
    });
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket.current?.close();
    };
  }, []);

  const send = useCallback((command: Command) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(command));
    else setError("还没有连接到引擎。");
  }, []);

  return { connected, state, activity, chat, error, showError: setError, dismissError: () => setError(null), send };
}
