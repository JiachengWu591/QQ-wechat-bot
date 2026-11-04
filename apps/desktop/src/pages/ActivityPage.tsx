import type { ActivityEntry } from "@shu/protocol";
import { ActivityRow } from "../ui.tsx";

export function ActivityPage({ entries }: { entries: ActivityEntry[] }) {
  return (
    <>
      <h1 className="page-title">活动</h1>
      {entries.length ? (
        <section className="panel">
          <ul className="activity-list">
            {entries.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} />
            ))}
          </ul>
        </section>
      ) : (
        <p className="empty">还没有活动记录。</p>
      )}
    </>
  );
}
