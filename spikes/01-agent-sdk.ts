// Checks the owner lane: the Agent SDK can run on the plan login or an API key,
// reports which one it used, starts with no tools, and stops promptly on abort.
//   npm run agent -- subscription | apikey | badkey | abort
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2] ?? "subscription";
const emptyDir = mkdtempSync(join(tmpdir(), "shu-spike-"));

// Started from inside a Claude session, a child run kept the host's login even with an
// invalid key, while still reporting apiKeySource ANTHROPIC_API_KEY. So inherited auth
// variables are dropped, and the report alone doesn't prove which credential was used.
function laneEnv(useApiKey: boolean): Record<string, string | undefined> {
  const { SHU_ANTHROPIC_API_KEY } = process.env;
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(ANTHROPIC_|CLAUDE|SHU_)|OAUTH/i.test(name)),
  );
  if (!useApiKey) return clean;
  // A key that can't work shows whether the run really uses the key.
  if (mode === "badkey") return { ...clean, ANTHROPIC_API_KEY: "sk-ant-api03-not-a-real-key" };
  if (!SHU_ANTHROPIC_API_KEY) {
    console.error("SHU_ANTHROPIC_API_KEY is not set in spikes/.env.local");
    process.exit(2);
  }
  return { ...clean, ANTHROPIC_API_KEY: SHU_ANTHROPIC_API_KEY };
}

async function run(prompt: string, useApiKey: boolean, abortAfterMs?: number) {
  const abortController = new AbortController();
  const started = Date.now();
  let abortedAt: number | undefined;
  if (abortAfterMs) {
    setTimeout(() => {
      abortedAt = Date.now();
      abortController.abort();
    }, abortAfterMs);
  }

  try {
    const session = query({
      prompt,
      options: {
        model: "claude-opus-5-5",
        cwd: emptyDir,
        env: laneEnv(useApiKey),
        settingSources: [],
        tools: [],
        persistSession: false,
        maxTurns: 1,
        abortController,
      },
    });
    for await (const message of session) {
      if (message.type === "system" && message.subtype === "init") {
        console.log("init", {
          apiKeySource: message.apiKeySource,
          model: message.model,
          tools: message.tools,
          mcpServers: message.mcp_servers.map((s) => `${s.name}:${s.status}`),
          claudeCodeVersion: message.claude_code_version,
        });
        const account = await session.accountInfo();
        console.log("account", {
          subscriptionType: account.subscriptionType,
          tokenSource: account.tokenSource,
          apiKeySource: account.apiKeySource,
        });
      } else if (message.type === "result") {
        console.log("result", {
          subtype: message.subtype,
          isError: message.is_error,
          text: message.subtype === "success" ? message.result : message.errors,
          costUsd: message.total_cost_usd,
          inputTokens: message.usage.input_tokens,
          cacheRead: message.usage.cache_read_input_tokens,
          cacheWrite: message.usage.cache_creation_input_tokens,
          outputTokens: message.usage.output_tokens,
          elapsedMs: Date.now() - started,
        });
      }
    }
  } catch (error) {
    if (abortedAt === undefined) {
      // The SDK's own error can include a large minified source dump.
      console.log("sdk error:", String(error instanceof Error ? error.message : error).slice(0, 300));
      process.exitCode = 1;
      return;
    }
    console.log("aborted", {
      stopLatencyMs: Date.now() - abortedAt,
      error: error instanceof Error ? error.name : String(error),
    });
  }
}

if (mode === "subscription") {
  await run("Reply with exactly: OK", false);
} else if (mode === "apikey" || mode === "badkey") {
  await run("Reply with exactly: OK", true);
} else if (mode === "abort") {
  await run("Write a 2000 word essay about rivers.", false, 3000);
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}
