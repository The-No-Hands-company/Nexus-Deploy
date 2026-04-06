/**
 * Lightweight in-process event bus.
 * Decouples build.ts → status-sync.ts circular dependency.
 */
type StatusListener = (projectId: string, status: string) => void;
const listeners = new Set<StatusListener>();

export function emitStatusChange(projectId: string, status: string) {
  listeners.forEach(fn => fn(projectId, status));
}

export function onStatusChange(fn: StatusListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
