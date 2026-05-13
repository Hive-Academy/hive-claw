import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, Dispatch, DispatchState } from '../services/api.service';
import { SseService } from '../services/sse.service';
import { ToastService } from '../services/toast.service';
import { SkeletonComponent } from '../components/skeleton.component';

const STATES: DispatchState[] = ['pending', 'taken', 'done', 'failed', 'poisoned'];

const STATE_BADGE: Record<DispatchState, string> = {
  pending: 'badge-ghost',
  taken: 'badge-accent',
  done: 'badge-success',
  failed: 'badge-error',
  poisoned: 'badge-error',
};

@Component({
  selector: 'oc-dispatches',
  standalone: true,
  imports: [FormsModule, SkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-4">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 class="text-2xl font-bold">Dispatches</h1>
        <div class="flex flex-wrap gap-2">
          <select class="select select-sm select-bordered" [(ngModel)]="filterState" (change)="apply()">
            <option value="">All states</option>
            @for (s of states; track s) { <option [value]="s">{{ s }}</option> }
          </select>
          <input class="input input-sm input-bordered w-full sm:w-48" [(ngModel)]="filterProject" (input)="apply()" placeholder="Project..." />
          <input class="input input-sm input-bordered w-full sm:w-48" [(ngModel)]="filterAgent" (input)="apply()" placeholder="Agent..." />
          <button class="btn btn-sm btn-outline" (click)="refresh()">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          </button>
        </div>
      </div>

      <div class="card bg-base-200 border border-base-300 overflow-x-auto">
        <table class="table table-sm">
          <thead>
            <tr>
              <th>ID</th>
              <th>Project</th>
              <th>Task</th>
              <th>Phase</th>
              <th>Agent</th>
              <th>State</th>
              <th>Exit</th>
              <th>Duration</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            @if (loading()) {
              @for (i of [1,2,3,4,5]; track i) {
                <tr>
                  @for (j of [1,2,3,4,5,6,7,8,9]; track j) {
                    <td><oc-skeleton cls="h-3 w-full" /></td>
                  }
                </tr>
              }
            } @else if (filtered().length === 0) {
              <tr><td colspan="9" class="text-center text-base-content/50 py-8">No dispatches found.</td></tr>
            } @else {
              @for (d of filtered(); track d.id) {
                <tr class="hover">
                  <td class="font-mono text-xs">{{ d.id.slice(0, 8) }}</td>
                  <td class="text-xs">{{ d.projectSlug }}</td>
                  <td class="font-mono text-xs">{{ d.taskId.slice(0, 8) }}</td>
                  <td><span class="badge badge-xs" [class]="phaseBadge(d.phase)">{{ d.phase }}</span></td>
                  <td>{{ d.agentId }}</td>
                  <td><span class="badge badge-xs" [class]="stateBadge(d.state)">{{ d.state }}</span></td>
                  <td>{{ d.exitCode ?? '—' }}</td>
                  <td>{{ d.durationMs ? (d.durationMs / 1000).toFixed(1) + 's' : '—' }}</td>
                  <td class="text-xs">{{ d.createdAt }}</td>
                </tr>
              }
            }
          </tbody>
        </table>
      </div>

      <div class="text-sm text-base-content/50">
        Showing {{ filtered().length }} of {{ dispatches().length }} dispatches
      </div>
    </div>
  `,
})
export class DispatchesComponent implements OnInit {
  private api = inject(ApiService);
  private sse = inject(SseService);
  dispatches = signal<Dispatch[]>([]);
  loading = signal(true);
  states = STATES;
  filterState = '';
  filterProject = '';
  filterAgent = '';

  filtered = computed(() => {
    let list = this.dispatches();
    const s = this.filterState.trim();
    const p = this.filterProject.toLowerCase().trim();
    const a = this.filterAgent.toLowerCase().trim();
    if (s) list = list.filter((d) => d.state === s);
    if (p) list = list.filter((d) => d.projectSlug.toLowerCase().includes(p));
    if (a) list = list.filter((d) => d.agentId.toLowerCase().includes(a));
    return list;
  });

  ngOnInit() {
    this.refresh();
    setInterval(() => {
      const evts = this.sse.events();
      if (evts.some((e) => e.type.startsWith('dispatch.'))) this.refresh();
    }, 5000);
  }

  refresh() {
    this.loading.set(true);
    this.api.dispatches({ limit: 200 }).subscribe({
      next: (d) => { this.dispatches.set(d); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  apply() {
    // computed signal re-evaluates automatically
  }

  phaseBadge(phase: string): string {
    switch (phase) {
      case 'CONTEXT': return 'badge-ghost';
      case 'DESCRIPTION': return 'badge-info';
      case 'PLAN': return 'badge-info';
      case 'PENDING': return 'badge-warning';
      case 'IN_PROGRESS': return 'badge-accent';
      case 'IMPLEMENTED': return 'badge-secondary';
      case 'COMPLETE': return 'badge-success';
      case 'QA_DONE': return 'badge-success';
      case 'DONE': return 'badge-success';
      default: return 'badge-error';
    }
  }

  stateBadge(state: DispatchState): string {
    return STATE_BADGE[state] ?? 'badge-ghost';
  }
}
