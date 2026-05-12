/**
 * ExtensionsPageComponent — top-level page for plugin/MCP install governance.
 *
 * Two tabs via a signal-driven view toggle (matches the `tasks.component.ts`
 * style of inline state — no nested router-outlet needed for a 2-tab page).
 *
 * Loads pending requests + installed inventory on activation; subsequent
 * updates are driven by `ExtensionsService` reacting to `installs.*` SSE
 * events (amendment-1 §16.3, §16.6).
 *
 * Note: until Batch 10 cutover wires `setDocker()` into the daemon, the
 * installed inventory endpoint will 503 — `installed-inventory.component`
 * renders the graceful empty state for that case.
 */
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { ExtensionsService } from '../../services/extensions.service';
import { PendingApprovalsComponent } from './pending-approvals.component';
import { InstalledInventoryComponent } from './installed-inventory.component';

type Tab = 'pending' | 'installed';

@Component({
  selector: 'oc-extensions-page',
  standalone: true,
  imports: [PendingApprovalsComponent, InstalledInventoryComponent],
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
      </div>

      @if (tab() === 'pending') {
        <oc-pending-approvals />
      } @else {
        <oc-installed-inventory />
      }
    </div>
  `,
})
export class ExtensionsPageComponent implements OnInit {
  private ext = inject(ExtensionsService);

  tab = signal<Tab>('pending');
  loading = signal(false);
  pendingCount = this.ext.pendingCount;

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.loading.set(true);
    // Both refreshes are independent; the service swallows individual errors
    // (e.g. 503 from installed when docker handle isn't wired pre-Batch 10).
    let outstanding = 2;
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
  }
}
