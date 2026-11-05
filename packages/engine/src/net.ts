// A failed fetch only ever says "fetch failed". The reason is in its cause, and that's what
// the activity log and retry decisions need.
export function networkErrorCode(error: unknown): string | undefined {
  return (error as { cause?: { code?: string } } | null | undefined)?.cause?.code;
}

export function describeNetworkError(error: unknown, platform: string): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "TimeoutError") return `连接${platform}超时`;
  const cause = error.cause as { code?: string; message?: string } | undefined;
  const reason = cause?.code || cause?.message;
  return reason ? `网络错误（${reason}）` : error.message;
}
