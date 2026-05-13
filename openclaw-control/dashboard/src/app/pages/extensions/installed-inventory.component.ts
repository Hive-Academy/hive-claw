/**
 * InstalledInventoryComponent — Tab 2 of the Extensions page.
 *
 * Read-only view of currently-installed plugins + MCP skills from
 * `GET /api/extensions/installed` and a tail of recent operator decisions
 * (audit history) computed from the install_requests history.
 *
 * Note: until Batch 10 cutover wires `setDocker()` in the daemon, the
 * `/api/extensions/installed` endpoint returns 503; we surface that with a
 * dedicated empty state (amendment §16.6 mentions Batch 10 dependency).
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ExtensionsService } from '../../services/extensions.service';

@Component({
  selector: 'oc-installed-inventory',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-4">
      <!-- Installed inventory -->
      <section class="space-y-2">
        <h2 class="text-lg font-semibold">Installed</h2>

        @let err = installedError();
        @let inv = installed();
        @if (err) {
          <div class="alert alert-warning text-sm">
            <div class="flex flex-col gap-1">
              <span class="font-semibold">Installed inventory unavailable</span>
              <span class="text-xs">{{ err }}</span>
              <span class="text-xs opacity-70">
                The daemon's docker handle is wired in Batch 10 (cutover). Until then this list
                will remain empty.
              </span>
            </div>
          </div>
        } @else if (inv) {
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div class="card bg-base-200 border border-base-300">
              <div class="card-body p-4">
                <div class="flex items-center justify-between">
                  <h3 class="font-semibold">Plugins</h3>
                  <span class="badge badge-ghost badge-sm">{{ inv.plugins.length }}</span>
                </div>
                @if (inv.plugins.length === 0) {
                  <p class="text-xs text-base-content/50 italic">No plugins installed.</p>
                } @else {
                  <ul class="space-y-1">
                    @for (p of inv.plugins; track p.slug) {
                      <li class="font-mono text-sm break-all">📦 {{ p.slug }}</li>
                    }
                  </ul>
                }
              </div>
            </div>
            <div class="card bg-base-200 border border-base-300">
              <div class="card-body p-4">
                <div class="flex items-center justify-between">
                  <h3 class="font-semibold">MCP skills</h3>
                  <span class="badge badge-ghost badge-sm">{{ inv.mcpSkills.length }}</span>
                </div>
                @if (inv.mcpSkills.length === 0) {
                  <p class="text-xs text-base-content/50 italic">No MCP skills installed.</p>
                } @else {
                  <ul class="space-y-1">
                    @for (s of inv.mcpSkills; track s.slug) {
                      <li class="font-mono text-sm break-all">🛠️ {{ s.slug }}</li>
                    }
                  </ul>
                }
              </div>
            </div>
          </div>
        } @else {
          <p class="text-sm text-base-content/60">Loading…</p>
        }
      </section>

      <!-- Recent decisions -->
      <section class="space-y-2">
        <h2 class="text-lg font-semibold">Recent decisions</h2>
        @if (recent().length === 0) {
          <p class="text-sm text-base-content/60 italic">No decisions recorded yet.</p>
        } @else {
          <div class="card bg-base-200 border border-base-300 overflow-hidden">
            <div class="overflow-x-auto">
              <table class="table table-sm">
                <thead class="bg-base-300/50">
                  <tr>
                    <th>When</th>
                    <th>Status</th>
                    <th>Kind</th>
                    <th>Slug</th>
                    <th>Requested by</th>
                    <th>Operator note</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of recent(); track r.id) {
                    <tr>
                      <td class="text-xs whitespace-nowrap">{{ r.decidedAt || r.createdAt }}</td>
                      <td><span class="badge badge-sm" [class]="statusBadge(r.status)">{{ r.status }}</span></td>
                      <td><span class="badge badge-ghost badge-sm">{{ r.kind }}</span></td>
                      <td class="font-mono text-xs break-all">{{ r.slug }}</td>
                      <td><span class="badge badge-outline badge-sm">{{ r.requestingAgentId }}</span></td>
                      <td class="text-xs text-base-content/70 max-w-xs truncate" [title]="r.operatorNote || ''">
                        {{ r.operatorNote || '—' }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        }
      </section>
    </div>
  `,
})
export class InstalledInventoryComponent {
  private ext = inject(ExtensionsService);

  installed = this.ext.installed;
  installedError = this.ext.installedError;
  recent = this.ext.recentDecisions;

  statusBadge(s: string): string {
    switch (s) {
      case 'applied':
        return 'badge-success';
      case 'approved':
        return 'badge-info';
      case 'rejected':
        return 'badge-error';
      case 'failed':
        return 'badge-error';
      default:
        return 'badge-ghost';
    }
  }
}
