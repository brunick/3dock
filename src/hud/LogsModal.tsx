/**
 * Container logs in a modal over the scene. Docker only: the service id is a container id and
 * the server forwards `GET /api/docker/containers/:id/logs`.
 */
import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store';
import { CloseIcon } from './icons';

const TAIL = 300;

export function LogsModal({ serviceId, name, onClose }: { serviceId: string; name: string; onClose: () => void }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setLines(await useStore.getState().fetchLogs(serviceId, TAIL));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [serviceId]);

  useEffect(() => {
    void load();
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
          <pre className="logs-body mono">{lines.join('\n')}</pre>
        )}
      </section>
    </div>
  );
}
