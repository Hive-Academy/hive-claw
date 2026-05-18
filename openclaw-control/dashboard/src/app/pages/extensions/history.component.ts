/**
 * HistoryComponent — Tab 3 of the Extensions page.
 *
 * Surfaces terminal-state install requests (approved + rejected + applied +
 * failed), newest-first. Critical for failed installs which would otherwise
 * vanish from the pending list with no operator feedback (the symptom that
 * motivated adding this tab).
 *
 * Read-only: rows here cannot be re-approved (status invariants in
 * `installWorker` enforce one terminal transition). Expand a row to view
 * the captured `install_output` for debugging.
 */
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  ExtensionsService,
  InstallRequest,
  InstallStatus,
} from '../../services/extensions.service';

@Component({
  selector: 'oc-extensions-history',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-3">
      @if (rows().length === 0) {
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body items-center text-center">
            <p class="text-base-content/70">No decisions yet.</p>
            <p class="text-xs text-base-content/50">
              Approved, rejected, applied, and failed install requests will show
              up here. The page auto-refreshes when an install pipeline event
              arrives.
            </p>
          </div>
        </div>
      } @else {
        @for (r of rows(); track r.id) {
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-4 space-y-2">
              <div class="flex items-start justify-between gap-3 flex-wrap">
                <div class="space-y-1 min-w-0 flex-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-lg">{{ r.kind === 'plugin' ? '📦' : '🛠️' }}</span>
                    <span class="font-mono text-sm font-semibold break-all">{{ r.slug }}</span>
                    <span class="badge badge-sm badge-ghost">{{ r.kind }}</span>
                    <span class="badge badge-sm" [class]="badgeClass(r.status)">
                      {{ r.status }}
                    </span>
                  </div>
                  <div class="text-xs text-base-content/60">
                    Requested by
                    <span class="badge badge-outline badge-sm">{{ r.requestingAgentId }}</span>
                    · created {{ formatRelative(r.createdAt) }}
                    @if (r.decidedAt) { · decided {{ formatRelative(r.decidedAt) }} }
                    @if (r.appliedAt) { · applied {{ formatRelative(r.appliedAt) }} }
                  </div>
                  @if (r.reason) {
                    <p class="text-sm text-base-content/80 italic">"{{ r.reason }}"</p>
                  }
                  @if (r.operatorNote) {
                    <p class="text-xs text-base-content/60">
                      Operator note: <span class="font-mono">{{ r.operatorNote }}</span>
                    </p>
                  }
                </div>
                @if (r.installOutput) {
                  <button class="btn btn-xs btn-ghost" (click)="toggle(r.id)">
                    {{ expanded().has(r.id) ? 'Hide' : 'Show' }} output
                  </button>
                }
              </div>
              @if (r.installOutput && expanded().has(r.id)) {
                <pre class="text-xs font-mono bg-base-300 rounded p-2 whitespace-pre-wrap break-all max-h-80 overflow-y-auto">{{ r.installOutput }}</pre>
              }
            </div>
          </div>
        }
      }
    </div>
  `,
})
export class ExtensionsHistoryComponent {
  private ext = inject(ExtensionsService);

  rows = this.ext.recentDecisions;
  expanded = signal<Set<number>>(new Set());

  toggle(id: number): void {
    const next = new Set(this.expanded());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expanded.set(next);
  }

  badgeClass(status: InstallStatus): string {
    switch (status) {
      case 'applied':
        return 'badge-success';
      case 'failed':
        return 'badge-error';
      case 'rejected':
        return 'badge-warning';
      case 'approved':
        return 'badge-info';
      default:
        return 'badge-ghost';
    }
  }

  formatRelative(iso: string | null): string {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return iso;
    const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return new Date(t).toLocaleString();
  }
}
