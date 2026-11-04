import type { ActivityEntry, ActivityLevel, Autonomy, Tier } from "@shu/protocol";

export const autonomyLabels: Record<Autonomy, string> = {
  notify: "只提醒",
  confirm: "确认后发送",
  auto: "自动回复",
};

export const tierLabels: Record<Tier, string> = {
  owner: "主人",
  trusted: "信任",
  member: "群友",
};

export function Switch(props: { checked: boolean; label: string; onChange(checked: boolean): void; large?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      className={`switch${props.large ? " switch-large" : ""}`}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="switch-thumb" />
    </button>
  );
}

const levelLabels: Record<ActivityLevel, string> = {
  info: "信息",
  ok: "完成",
  blocked: "已拦截",
  error: "出错",
};

export function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatCost(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function ActivityRow({ entry }: { entry: ActivityEntry }) {
  return (
    <li className="activity-row">
      <span className={`dot dot-${entry.level}`} title={levelLabels[entry.level]} />
      <time>{formatTime(entry.at)}</time>
      <span className="activity-summary">
        {entry.conversationTitle ? <span className="activity-where">{entry.conversationTitle}</span> : null}
        {entry.summary}
      </span>
      {entry.costUsd === undefined ? null : <span className="activity-cost">{formatCost(entry.costUsd)}</span>}
    </li>
  );
}
