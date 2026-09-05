import type { ServerResponse } from 'node:http';
import type { Store } from '@interlock/store';

/**
 * The live decision stream, as server-sent events.
 *
 * The console runs beside the proxy, not inside it, so there is no in-process
 * event bus to subscribe to — the two share a SQLite file and nothing else.
 * The audit log is therefore the stream: it is append-only, its `seq` is
 * gapless by I6, and every state change in the system puts exactly one record
 * in it. Tailing it means the console shows the same history an auditor would
 * reconstruct, rather than a parallel feed that could disagree with it.
 *
 * Polling, deliberately. A watcher on the file would fire on WAL checkpoints
 * rather than on commits, and SQLite has no notification we can wait on across
 * processes. At one poll a second against an indexed integer this is cheaper
 * than the machinery required to avoid it.
 */

export interface StreamOptions {
  readonly store: Store;
  readonly intervalMs?: number;
  /** Start from here rather than from the current head. Used by Last-Event-ID. */
  readonly fromSeq?: number;
}

function write(res: ServerResponse, event: string, data: unknown, id?: number): void {
  const payload = JSON.stringify(data);
  res.write(
    `${id === undefined ? '' : `id: ${String(id)}\n`}event: ${event}\ndata: ${payload}\n\n`,
  );
}

export function streamAuditLog(res: ServerResponse, options: StreamOptions): () => void {
  const interval = options.intervalMs ?? 1000;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // Nginx and most reverse proxies buffer responses by default, which turns
    // a live stream into one long silence followed by everything at once.
    'x-accel-buffering': 'no',
  });

  const head = options.store.audit.head();
  // Default to the current head, not to genesis: a console opening on a ledger
  // with a year of history should not replay the year.
  let cursor = options.fromSeq ?? head?.seq ?? 0;

  write(res, 'hello', { from_seq: cursor, records: options.store.audit.count() });

  const tick = (): void => {
    try {
      const records = options.store.audit.read(cursor + 1, 200);
      for (const record of records) {
        write(res, 'audit', record, record.seq);
        cursor = record.seq;
      }
      if (records.length === 0) {
        // A comment frame. Keeps intermediaries from timing the connection out
        // during a quiet period, and costs two bytes.
        res.write(': keep-alive\n\n');
      }
    } catch (error) {
      write(res, 'error', { message: error instanceof Error ? error.message : String(error) });
    }
  };

  const timer = setInterval(tick, interval);
  // Never hold the process open for a browser tab someone left open.
  timer.unref?.();

  const stop = (): void => {
    clearInterval(timer);
    res.end();
  };
  res.on('close', () => clearInterval(timer));
  return stop;
}
