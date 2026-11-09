/** Keep cancellation active through body consumption, including on older WebKit. */
export async function withRequestTimeout<T>(
  milliseconds: number,
  parent: AbortSignal | null | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (parent?.aborted) cancel();
  else parent?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, milliseconds);
  try {
    return await operation(controller.signal);
  } finally {
    // Early validation failures may leave a response body unread.
    controller.abort();
    clearTimeout(timer);
    parent?.removeEventListener('abort', cancel);
  }
}
