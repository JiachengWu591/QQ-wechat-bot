import { useEffect, useState } from "react";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import {
  DEFAULT_PERSONA,
  MAX_PERSONA_CARD_CHARS,
  MAX_PERSONA_EXAMPLE_CHARS,
  MAX_PERSONA_EXAMPLES,
  personaModeLabels,
  personaModes,
  type EngineState,
  type Persona,
  type PersonaMode,
} from "@shu/protocol";
import type { EngineApi } from "../useEngine.ts";

const modeNotes: Record<PersonaMode, string> = {
  off: "照常说话，不用人设。",
  trial: "只在“聊天”页的模拟聊天里用，包括模拟私聊。真实的 QQ 和微信照常。适合先试一试。",
  on: "QQ 群、QQ 私聊（包括你和它的私聊）和模拟聊天都用。你在微信私聊里交给它的工作照常说话。",
};

const sameAs = (a: Persona, b: Persona) => JSON.stringify(a) === JSON.stringify(b);

export function PersonaPage({ engine, state }: { engine: EngineApi; state: EngineState }) {
  const saved = state.persona;
  const [draft, setDraft] = useState<Persona>(saved);
  // The saved version this draft started from, so an example added from the chat page shows up
  // here unless the owner is in the middle of editing.
  const [base, setBase] = useState<Persona>(saved);
  const dirty = !sameAs(draft, saved);
  // Saved from somewhere else while the owner was editing here.
  const changedElsewhere = !sameAs(base, saved) && !sameAs(draft, base);

  // Runs only when the saved persona itself changes.
  useEffect(() => {
    if (sameAs(draft, base)) {
      setDraft(saved);
      setBase(saved);
    }
  }, [JSON.stringify(saved)]);

  const examples = draft.examples;
  const halfFilled = examples.some((example) => !example.said.trim() !== !example.reply.trim());
  const filled = examples.filter((example) => example.said.trim() && example.reply.trim());
  const tooLong = draft.card.length > MAX_PERSONA_CARD_CHARS;
  const size = draft.card.length + filled.reduce((sum, example) => sum + example.said.length + example.reply.length, 0);

  function update(changes: Partial<Persona>) {
    setDraft((current) => ({ ...current, ...changes }));
  }

  function setExample(index: number, field: "said" | "reply", value: string) {
    update({ examples: examples.map((example, at) => (at === index ? { ...example, [field]: value } : example)) });
  }

  // What goes out is what the editor then shows, so it reads as saved once the engine confirms.
  function save() {
    const next = { ...draft, examples: filled.map(({ said, reply }) => ({ said: said.trim(), reply: reply.trim() })) };
    engine.send({ type: "persona.set", persona: next });
    setDraft(next);
    setBase(next);
  }

  function discard() {
    setDraft(saved);
    setBase(saved);
  }

  return (
    <>
      <h1 className="page-title">人设</h1>

      <section className="panel">
        <h2>在哪里用</h2>
        <div className="persona-modes" role="radiogroup" aria-label="人设用在哪里">
          {personaModes.map((mode) => (
            <label key={mode} className={`persona-mode${draft.mode === mode ? " persona-mode-current" : ""}`}>
              <input type="radio" name="persona-mode" value={mode} checked={draft.mode === mode} onChange={() => update({ mode })} />
              <span>
                <strong>{personaModeLabels[mode]}</strong>
                <span className="panel-meta">{modeNotes[mode]}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="panel-meta">人设只改变说话的方式。谁是主人、谁能用什么工具，都由程序决定，人设改不了。有人认真问它是不是 AI，它会承认。</p>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>人设卡</h2>
          <button type="button" className="button" onClick={() => update({ card: DEFAULT_PERSONA.card, examples: DEFAULT_PERSONA.examples })}>
            <RotateCcw size={14} aria-hidden="true" />
            换回默认草稿
          </button>
        </div>
        <p className="panel-meta">写清楚它是谁、在乎什么、说话有什么习惯、哪些话不说。</p>
        <label className="visually-hidden" htmlFor="persona-card">
          人设卡
        </label>
        <textarea id="persona-card" rows={14} value={draft.card} onChange={(event) => update({ card: event.target.value })} />
        <p className={tooLong ? "form-error" : "panel-meta"}>
          {draft.card.length} / {MAX_PERSONA_CARD_CHARS} 字
        </p>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>示例对话</h2>
          <span className="panel-meta">
            {filled.length} / {MAX_PERSONA_EXAMPLES} 条
          </span>
        </div>
        <p className="panel-meta">最管用的一部分：别人说什么，它怎么回。它只学语气和长短，不会照抄。在“聊天”页里，bot 的回复下面可以点“改成这样”，改好的会加到这里。台词要自己写，不要照搬游戏里的原台词。</p>
        {examples.length ? (
          <ul className="persona-examples">
            {examples.map((example, index) => (
              <li key={index} className="persona-example">
                <input
                  className="title-input"
                  aria-label={`第 ${index + 1} 条：别人说`}
                  placeholder="别人说"
                  maxLength={MAX_PERSONA_EXAMPLE_CHARS}
                  value={example.said}
                  onChange={(event) => setExample(index, "said", event.target.value)}
                />
                <input
                  className="title-input"
                  aria-label={`第 ${index + 1} 条：它回`}
                  placeholder="它回"
                  maxLength={MAX_PERSONA_EXAMPLE_CHARS}
                  value={example.reply}
                  onChange={(event) => setExample(index, "reply", event.target.value)}
                />
                <button type="button" className="icon-button" aria-label={`删掉第 ${index + 1} 条`} title="删掉" onClick={() => update({ examples: examples.filter((_, at) => at !== index) })}>
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">还没有示例。</p>
        )}
        <div className="actions">
          <button type="button" className="button" disabled={examples.length >= MAX_PERSONA_EXAMPLES} onClick={() => update({ examples: [...examples, { said: "", reply: "" }] })}>
            <Plus size={14} aria-hidden="true" />
            加一条
          </button>
          {halfFilled ? <span className="form-error">有的示例只填了一半，保存时会跳过。</span> : null}
        </div>
      </section>

      <div className="persona-save">
        <button type="button" className="button button-primary" disabled={!dirty || tooLong} onClick={save}>
          保存
        </button>
        <button type="button" className="button" disabled={!dirty} onClick={discard}>
          放弃修改
        </button>
        <span className="panel-meta">
          {changedElsewhere ? "刚才有别处改了人设（比如从聊天里加了示例），保存会覆盖它。" : `约 ${size} 字。启用后每条回复都带上人设，连续聊天时会用缓存，多出来的费用很少。`}
        </span>
      </div>
    </>
  );
}
