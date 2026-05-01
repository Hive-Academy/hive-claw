/**
 * Cross-process claim worker for T6.2.
 *
 * Spawned by `dispatch-claim.test.ts` with `worker_threads`. Each worker
 * opens its OWN better-sqlite3 handle against the shared on-disk SQLite
 * file, then races `attempts` claim attempts against the dispatch id.
 *
 * Reports its winner count back to the parent on the message channel.
 *
 * Note: this file is loaded into a worker_thread via tsx. We bypass the
 * daemon's `setup.ts` (which mutates env at top level) and the `db/client.ts`
 * singleton (which would force every worker to share an in-memory map);
 * instead we open a fresh `better-sqlite3` Database directly. This is the
 * adversarial setup the implementation-plan §12.1 cross-process variant
 * targets — N independent processes, one DB file.
 */

import { parentPort, workerData } from 'node:worker_threads';
import BetterSqlite3 from 'better-sqlite3';

interface WorkerData {
  dbPath: string;
  dispatchId: string;
  workerIndex: number;
  attempts: number;
}

const { dbPath, dispatchId, workerIndex, attempts } = workerData as WorkerData;

if (!parentPort) {
  throw new Error('worker-claim: parentPort missing — must be spawned via worker_threads');
}

// Open a private handle. Match the leader's pragmas so the worker plays by
// the same WAL rules under contention.
const db = new BetterSqlite3(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('temp_store = MEMORY');

// Same SQL as DispatchRepo.claim — single-statement linearization point.
const claim = db.prepare(`
  UPDATE dispatches
     SET state = 'taken',
         claimed_by = @claimed_by,
         claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id = @id
     AND state = 'pending'
  RETURNING id
`);

let winners = 0;
for (let i = 0; i < attempts; i++) {
  const claimedBy = `worker-${workerIndex}-attempt-${i}`;
  const row = claim.get({ id: dispatchId, claimed_by: claimedBy }) as
    | { id: string }
    | undefined;
  if (row) winners += 1;
}

db.close();
parentPort.postMessage({ winners });
