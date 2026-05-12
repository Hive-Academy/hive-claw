/**
 * PendingApprovalsComponent — Tab 1 of the Extensions page.
 *
 * Lists `extension_install_requests` rows with status='pending' and lets the
 * operator approve (apply-now or apply-on-next-restart) or reject each, with
 * an optional per-row note (amendment-1 §16.6).
 *
 * State is owned by the parent page via `ExtensionsService` (signal-backed).
 * This component reads `pending()` and posts back through the service; SSE
 * lifecycle events drive cache refresh in the service, not here.
 */
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  ExtensionsService,
  InstallRequest,
} from '../../services/extensions.service';
import { ToastService } from '../../services/toast.service';

@Component({
  selector: 'oc-pending-approvals',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-3">
      @if (pending().length === 0) {
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body items-center text-center">
            <p class="text-base-content/70">No pending install requests.</p>
            <p class="text-xs text-base-content/50">
              Agents request installs via the openclaw plugin's
              <kbd class="kbd kbd-sm">request_plugin_install</kbd> /
              <kbd class="kbd kbd-sm">request_mcp_skill_install</kbd> tools.
            </p>
          </div>
        </div>
      } @else {
        @for (r of pending(); track r.id) {
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-4 space-y-3">
              <div class="flex items-start justify-between gap-3">
                <div class="space-y-1 min-w-0 flex-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-lg">{{ r.kind === 'plugin' ? '📦' : '🛠️' }}</span>
                    <span class="font-mono text-sm font-semibold break-all">{{ r.slug }}</span>
                    <span class="badge badge-sm badge-ghost">{{ r.kind }}</span>
                  </div>
                  <div class="text-xs text-base-content/60">
                    Requested by
                    <span class="badge badge-outline badge-sm">{{ r.requestingAgentId }}</span>
                    · {{ formatRelative(r.createdAt) }}
                  </div>
                  @if (r.reason) {
                    <p class="text-sm text-base-content/80 italic">"{{ r.reason }}"</p>
                  }
                </div>
              </div>

              <textarea
                class="textarea textarea-bordered textarea-sm w-full"
                rows="2"
                placeholder="Note (optional) — will be recorded in the audit history."
                [ngModel]="noteFor(r.id)"
                (ngModelChange)="setNote(r.id, $event)"
              ></textarea>

              <div class="flex flex-wrap gap-2">
                <button
                  class="btn btn-sm btn-primary"
                  [disabled]="busy().has(r.id)"
                  (click)="approve(r, false)"
                  title="Apply install immediately. Gateway restarts; ~10-30s downtime."
                >
                  @if (busy().has(r.id)) { <span class="loading loading-spinner loading-xs"></span> }
                  Approve &amp; Apply now
                </button>
                <button
                  class="btn btn-sm btn-outline btn-primary"
                  [disabled]="busy().has(r.id)"
                  (click)="approve(r, true)"
                  title="Mark approved but defer install until next gateway restart."
                >
                  Approve, apply on next restart
                </button>
                <button
                  class="btn btn-sm btn-outline btn-error"
                  [disabled]="busy().has(r.id)"
                  (click)="reject(r)"
                >
                  Reject
                </button>
              </div>
            </div>
          </div>
        }
      }
    </div>
  `,
})
export class PendingApprovalsComponent {
  private ext = inject(ExtensionsService);
  private toast = inject(ToastService);

  pending = this.ext.pending;
  busy = signal<Set<number>>(new Set());
  private notes = signal<Map<number, string>>(new Map());

  noteFor(id: number): string {
    return this.notes().get(id) ?? '';
  }

  setNote(id: number, value: string): void {
    const next = new Map(this.notes());
    if (value) next.set(id, value);
    else next.delete(id);
    this.notes.set(next);
  }

  approve(r: InstallRequest, deferApply: boolean): void {
    this.markBusy(r.id, true);
    const note = this.noteFor(r.id).trim() || undefined;
    this.ext.approve(r.id, { note, deferApply }).subscribe({
      next: (resp) => {
        this.markBusy(r.id, false);
        this.clearNote(r.id);
        if (deferApply) {
          this.toast.success(`Approved ${r.slug} — will apply on next gateway restart`);
        } else {
          this.toast.info(
            `Installing ${r.slug}… estimated ${resp.estimatedRestartSeconds ?? 10}-30s downtime`,
          );
        }
        // The service's SSE-driven effect also refreshes; calling explicitly
        // here gives the operator immediate UI feedback even on slow streams.
        this.ext.refreshPending();
      },
      error: (err) => {
        this.markBusy(r.id, false);
        this.toast.error(err?.error?.error || 'Approve failed');
      },
    });
  }

  reject(r: InstallRequest): void {
    this.markBusy(r.id, true);
    const note = this.noteFor(r.id).trim() || undefined;
    this.ext.reject(r.id, { note }).subscribe({
      next: () => {
        this.markBusy(r.id, false);
        this.clearNote(r.id);
        this.toast.success(`Rejected ${r.slug}`);
        this.ext.refreshPending();
      },
      error: (err) => {
        this.markBusy(r.id, false);
        this.toast.error(err?.error?.error || 'Reject failed');
      },
    });
  }

  formatRelative(iso: string): string {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return iso;
    const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return new Date(t).toLocaleString();
  }

  private markBusy(id: number, on: boolean): void {
    const next = new Set(this.busy());
    if (on) next.add(id);
    else next.delete(id);
    this.busy.set(next);
  }

  private clearNote(id: number): void {
    const next = new Map(this.notes());
    next.delete(id);
    this.notes.set(next);
  }
}
