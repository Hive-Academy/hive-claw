/**
 * ExtensionsService — dashboard HTTP + SSE wrapper for the daemon's
 * extension install routes (amendment-1 §16.3) + the in-process install
 * worker's lifecycle events.
 *
 * Auth model (mirrors api.ts):
 *   - All routes here are called with `withCredentials: true`; the operator
 *     dashboard is cookie-authenticated. Approve/reject routes are
 *     intentionally cookie-only on the daemon side (§16.3) — the plugin's
 *     Bearer must not be able to self-approve.
 *
 * Live updates: the shared `SseService` is already connected at app shell
 * boot and now listens for `installs.*` events. This service exposes a
 * computed signal `events` that filters down to that prefix and refreshes
 * its caches on the relevant lifecycle transitions.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';
import { SseService, SseEvent } from './sse.service';

export type InstallKind = 'plugin' | 'mcp_skill';
export type InstallStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'failed';

/** Mirrors `daemon/src/db/installRequests.ts:InstallRequest`. */
export interface InstallRequest {
  id: number;
  kind: InstallKind;
  slug: string;
  requestingAgentId: string;
  reason: string | null;
  status: InstallStatus;
  operatorNote: string | null;
  installOutput: string | null;
  createdAt: string;
  decidedAt: string | null;
  appliedAt: string | null;
}

/** Mirrors `daemon/src/installWorker.ts:InstalledInventory`. */
export interface InstalledInventory {
  plugins: ReadonlyArray<{ slug: string; raw?: unknown }>;
  mcpSkills: ReadonlyArray<{ slug: string; raw?: unknown }>;
}

export interface ApproveResponse {
  status: InstallStatus;
  deferApply: boolean;
  estimatedRestartSeconds: number | null;
}

@Injectable({ providedIn: 'root' })
export class ExtensionsService {
  private http = inject(HttpClient);
  private sse = inject(SseService);

  /** Pending requests cache. */
  readonly pending = signal<InstallRequest[]>([]);
  /** Installed inventory cache. `null` = not yet loaded; `error` = 503 from daemon (Batch 10 not cut over). */
  readonly installed = signal<InstalledInventory | null>(null);
  readonly installedError = signal<string | null>(null);
  /** Recent decision history (approved + rejected + applied + failed), most-recent-first. */
  readonly recentDecisions = signal<InstallRequest[]>([]);

  /** Nav badge — pending count. */
  readonly pendingCount = computed(() => this.pending().length);

  /** SSE events relevant to this service (installs.* only). */
  readonly events = computed<SseEvent[]>(() =>
    this.sse.events().filter((e) => e.type.startsWith('installs.')),
  );

  private lastSeenInstallEventTs = 0;

  constructor() {
    // Live-update side effect: when an installs.* event arrives, refresh
    // pending list (cheap — small table) and update installed inventory on
    // applied/failed terminal transitions.
    effect(() => {
      const evts = this.events();
      if (evts.length === 0) return;
      const newest = evts[0];
      if (!newest || newest.ts <= this.lastSeenInstallEventTs) return;
      this.lastSeenInstallEventTs = newest.ts;
      // Anything that changes the pending set: requested/approved/rejected/applied/failed.
      this.refreshPending();
      if (newest.type === 'installs.applied' || newest.type === 'installs.failed') {
        this.refreshInstalled();
      }
    });
  }

  // ---- HTTP wrappers ----------------------------------------------------

  listPending(): Observable<{ requests: InstallRequest[] }> {
    return this.http.get<{ requests: InstallRequest[] }>(
      '/api/extensions/install-requests/pending',
      { withCredentials: true },
    );
  }

  getRequest(id: number): Observable<InstallRequest> {
    return this.http.get<InstallRequest>(`/api/extensions/install-requests/${id}`, {
      withCredentials: true,
    });
  }

  approve(
    id: number,
    body: { note?: string | null; deferApply?: boolean } = {},
  ): Observable<ApproveResponse> {
    return this.http.post<ApproveResponse>(
      `/api/extensions/install-requests/${id}/approve`,
      body,
      { withCredentials: true },
    );
  }

  reject(id: number, body: { note?: string | null } = {}): Observable<{ status: InstallStatus }> {
    return this.http.post<{ status: InstallStatus }>(
      `/api/extensions/install-requests/${id}/reject`,
      body,
      { withCredentials: true },
    );
  }

  listInstalled(): Observable<InstalledInventory> {
    return this.http.get<InstalledInventory>('/api/extensions/installed', {
      withCredentials: true,
    });
  }

  // ---- Cache refresh helpers -------------------------------------------

  refreshPending(): void {
    this.listPending().subscribe({
      next: (resp) => this.pending.set(resp.requests ?? []),
      // Soft failure — leave the existing cache in place. The page surfaces
      // its own loading/error state on the initial load; SSE-driven refreshes
      // should not clobber the visible list on a transient network blip.
      error: () => {},
    });
  }

  refreshInstalled(): void {
    this.listInstalled().subscribe({
      next: (inv) => {
        this.installed.set(inv);
        this.installedError.set(null);
      },
      error: (err) => {
        const msg = err?.error?.error || err?.message || 'failed to load installed inventory';
        this.installedError.set(msg);
        this.installed.set({ plugins: [], mcpSkills: [] });
      },
    });
  }
}
