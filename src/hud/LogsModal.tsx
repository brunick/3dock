/**
 * Container logs in a modal over the scene. Docker only: the service id is a container id and
 * the server forwards `GET /api/docker/containers/:id/logs`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { CloseIcon } from './icons';

const TAIL = 300;

export function LogsModal({ serviceId, name, onClose }: { serviceId: string; name: string; onClose: () => void }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLPreElement>(null);

  // Newest lines are at the bottom; follow them unless the reader scrolled up.
  useEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const stick = useRef(true);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) {
        setBusy(true);
        setError(null);
        stick.current = true;
      } else if (body.current) {
        // Keep the reader where he is unless he already sits at the bottom.
        const el = body.current;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 12;
      }
      try {
        const next = await useStore.getState().fetchLogs(serviceId, TAIL);
        setLines(next);
        setError(null);
      } catch (e) {
        if (!silent) setError((e as Error).message);
      } finally {
        if (!silent) setBusy(false);
      }
    },
    [serviceId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // While the window is open, keep pulling new lines.
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) void load(true);
    }, 1_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="logs-overlay" role="dialog" aria-modal="true" aria-label={`Logs of ${name}`} onClick={onClose}>
      <section className="logs-modal panel" onClick={(e) => e.stopPropagation()}>
        <header className="logs-head">
          <span className="label">Logs</span>
          <strong className="truncate">{name}</strong>
          <span className="muted small">{busy ? 'loading…' : `${lines?.length ?? 0} lines`}</span>
          <button type="button" className="link" onClick={() => void load()} disabled={busy} title="Reload the last lines">
            Reload
          </button>
          <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Close logs">
            <CloseIcon />
          </button>
        </header>
        {error ? (
          <p className="pop-error small logs-empty">{error}</p>
        ) : lines === null ? (
          <p className="muted small logs-empty">Loading…</p>
        ) : lines.length === 0 ? (
          <p className="muted small logs-empty">No log lines.</p>
        ) : (
          <pre ref={body} className="logs-body mono">{lines.join('\n')}</pre>
        )}
      </section>
    </div>
  );
}
