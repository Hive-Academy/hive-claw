/**
 * ExtensionsPageComponent — top-level page for plugin/MCP install governance.
 *
 * Three tabs via a signal-driven view toggle (matches the `tasks.component.ts`
 * style of inline state — no nested router-outlet needed for a 3-tab page).
 *
 * Loads pending + installed + history on activation; subsequent updates are
 * driven by `ExtensionsService` reacting to `installs.*` SSE events
 * (amendment-1 §16.3, §16.6). The History tab was added in the follow-up
 * pass after a failed install vanished from "Pending" with no operator
 * feedback.
 *
 * Note: until Batch 10 cutover wires `setDocker()` into the daemon, the
 * installed inventory endpoint will 503 — `installed-inventory.component`
 * renders the graceful empty state for that case.
 */
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { ExtensionsService } from '../../services/extensions.service';
import { PendingApprovalsComponent } from './pending-approvals.component';
import { InstalledInventoryComponent } from './installed-inventory.component';
import { ExtensionsHistoryComponent } from './history.component';

type Tab = 'pending' | 'installed' | 'history';

@Component({
  selector: 'oc-extensions-page',
  standalone: true,
  imports: [PendingApprovalsComponent, InstalledInventoryComponent, ExtensionsHistoryComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-4">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 class="text-2xl font-bold">Extensions</h1>
          <p class="text-xs text-base-content/60 mt-1">
            Operator review for agent-requested plugins and MCP skills.
            Approve or reject; "Apply now" restarts the openclaw gateway.
          </p>
        </div>
        <button class="btn btn-sm btn-outline" (click)="refresh()" [disabled]="loading()" title="Refresh">
          @if (loading()) { <span class="loading loading-spinner loading-xs"></span> }
          Refresh
        </button>
      </div>

      <div role="tablist" class="tabs tabs-bordered">
        <a
          role="tab"
          class="tab gap-2"
          [class.tab-active]="tab() === 'pending'"
          (click)="tab.set('pending')"
        >
          Pending approvals
          @if (pendingCount() > 0) {
            <span class="badge badge-warning badge-sm">{{ pendingCount() }}</span>
          }
        </a>
        <a
          role="tab"
          class="tab"
          [class.tab-active]="tab() === 'installed'"
          (click)="tab.set('installed')"
        >
          Installed inventory
        </a>
        <a
          role="tab"
          class="tab gap-2"
          [class.tab-active]="tab() === 'history'"
          (click)="tab.set('history')"
        >
          History
          @if (historyCount() > 0) {
            <span class="badge badge-ghost badge-sm">{{ historyCount() }}</span>
          }
        </a>
      </div>

      @if (tab() === 'pending') {
        <oc-pending-approvals />
      } @else if (tab() === 'installed') {
        <oc-installed-inventory />
      } @else {
        <oc-extensions-history />
      }
    </div>
  `,
})
export class ExtensionsPageComponent implements OnInit {
  private ext = inject(ExtensionsService);

  tab = signal<Tab>('pending');
  loading = signal(false);
  pendingCount = this.ext.pendingCount;
  historyCount = computed(() => this.ext.recentDecisions().length);

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.loading.set(true);
    // Three independent refreshes; the service swallows individual errors
    // (e.g. 503 from installed when docker handle isn't wired pre-Batch 10).
    let outstanding = 3;
    const done = () => {
      outstanding -= 1;
      if (outstanding === 0) this.loading.set(false);
    };
    this.ext.listPending().subscribe({
      next: (resp) => {
        this.ext.pending.set(resp.requests ?? []);
        done();
      },
      error: () => done(),
    });
    this.ext.listInstalled().subscribe({
      next: (inv) => {
        this.ext.installed.set(inv);
        this.ext.installedError.set(null);
        done();
      },
      error: (err) => {
        const msg = err?.error?.error || err?.message || 'failed to load installed inventory';
        this.ext.installedError.set(msg);
        this.ext.installed.set({ plugins: [], mcpSkills: [] });
        done();
      },
    });
    this.ext.listHistory().subscribe({
      next: (resp) => {
        this.ext.recentDecisions.set(resp.requests ?? []);
        done();
      },
      error: () => done(),
    });
  }
}
