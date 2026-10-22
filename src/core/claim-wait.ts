/** Cooperative, bounded retry. No transaction or partial claim is held while sleeping. */
export async function waitForClaim<T extends { ok: boolean }>(params: {
  attempt: () => T; heartbeat: () => void; signal?: AbortSignal; waitTimeoutMs: number;
}): Promise<T & { waitedMs: number; waitTimedOut: boolean }> {
  const { waitTimeoutMs, signal } = params;
  if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 0 || waitTimeoutMs > 600_000) {
    throw new Error('waitTimeoutMs must be an integer between 0 and 600000');
  }
  const started = performance.now();
  let previous: T | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const elapsed = Math.round(performance.now() - started);
    if (previous && elapsed >= waitTimeoutMs) return { ...previous, waitedMs: elapsed, waitTimedOut: true };
    params.heartbeat();
    const result = params.attempt();
    const waitedMs = Math.round(performance.now() - started);
    if (result.ok || waitedMs >= waitTimeoutMs) return { ...result, waitedMs, waitTimedOut: !result.ok };
    previous = result;
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal!.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.min(100, waitTimeoutMs - waitedMs));
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}
