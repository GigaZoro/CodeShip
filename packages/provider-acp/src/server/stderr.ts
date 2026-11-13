const ACP_STDERR_TAIL_MAX_CHARS = 4_096;

export function appendAcpStderrTail(current: string, chunk: string): string {
  const next = `${current}${chunk}`;
  return next.length <= ACP_STDERR_TAIL_MAX_CHARS ? next : next.slice(-ACP_STDERR_TAIL_MAX_CHARS);
}
