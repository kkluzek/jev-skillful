/** Emit exactly one JSON line and resolve only after Node reports that it was flushed. */
export async function writeHookPayload(payload: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (written: boolean): void => {
      if (settled) return;
      settled = true;
      process.stdout.off("error", onError);
      resolve(written);
    };
    const failAfterErrorEventWindow = (): void => {
      // Writable streams can invoke the callback with EPIPE and emit `error` immediately after it.
      // Keep the listener through the current I/O turn so that failure cannot crash the host.
      setImmediate(() => finish(false));
    };
    const onError = (): void => finish(false);
    process.stdout.once("error", onError);
    try {
      const line = `${JSON.stringify(payload)}\n`;
      process.stdout.write(line, (error) => {
        if (error === undefined || error === null) finish(true);
        else failAfterErrorEventWindow();
      });
    } catch {
      failAfterErrorEventWindow();
    }
  });
}
