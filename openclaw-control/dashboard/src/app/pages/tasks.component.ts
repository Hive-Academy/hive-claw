import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { RouterLink, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ApiService, TaskSummary } from '../services/api.service';
import { ToastService } from '../services/toast.service';
import { SkeletonComponent } from '../components/skeleton.component';

const PHASES = ['CONTEXT', 'DESCRIPTION', 'PLAN', 'PENDING', 'IN_PROGRESS', 'IMPLEMENTED', 'COMPLETE', 'QA_DONE', 'DONE'] as const;

const PHASE_BADGE: Record<string, string> = {
  CONTEXT: 'badge-ghost',
  DESCRIPTION: 'badge-info',
  PLAN: 'badge-info',
  PENDING: 'badge-warning',
  IN_PROGRESS: 'badge-accent',
  IMPLEMENTED: 'badge-secondary',
  COMPLETE: 'badge-success',
  QA_DONE: 'badge-success',
  DONE: 'badge-success',
  UNKNOWN: 'badge-error',
};

const COLLAPSED_PHASES_DEFAULT = new Set<string>(['DONE', 'QA_DONE']);

@Component({
  selector: 'oc-tasks',
  standalone: true,
  imports: [RouterLink, FormsModule, SkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-4">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <a routerLink="/projects" class="text-sm text-primary hover:underline">← projects</a>
          <h1 class="text-2xl font-bold mt-1">{{ slug() }}</h1>
        </div>
        <div class="flex gap-2">
          <input
            type="text"
            placeholder="Filter tasks..."
            class="input input-sm input-bordered w-full sm:w-56"
            [(ngModel)]="query"
          />
          <button class="btn btn-sm btn-outline" (click)="refresh()" title="Refresh">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          </button>
        </div>
      </div>

      <!-- Stats row -->
      @if (!loading()) {
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div class="stat bg-base-200 rounded-box p-3">
            <div class="stat-title text-xs">Total</div>
            <div class="stat-value text-lg">{{ tasks().length }}</div>
          </div>
          <div class="stat bg-base-200 rounded-box p-3">
            <div class="stat-title text-xs">Open</div>
            <div class="stat-value text-lg text-info">{{ openCount() }}</div>
          </div>
          <div class="stat bg-base-200 rounded-box p-3">
            <div class="stat-title text-xs">Checkpoints</div>
            <div class="stat-value text-lg text-warning">{{ checkpointCount() }}</div>
          </div>
          <div class="stat bg-base-200 rounded-box p-3">
            <div class="stat-title text-xs">Done</div>
            <div class="stat-value text-lg text-success">{{ doneCount() }}</div>
          </div>
        </div>
      }

      <!-- New task -->
      <div class="card bg-base-200 border border-base-300">
        <div class="card-body p-4">
          <div class="font-semibold mb-2">New task</div>
          <div class="flex flex-col sm:flex-row gap-2">
            <input
              [(ngModel)]="newDesc"
              placeholder="Describe a task — e.g. 'add health metrics endpoint'"
              class="input input-sm input-bordered flex-1"
              (keydown.enter)="create()"
            />
            <input
              [(ngModel)]="newAgent"
              placeholder="agent (default: anubis)"
              class="input input-sm input-bordered w-full sm:w-48"
              (keydown.enter)="create()"
            />
            <button class="btn btn-sm btn-primary" [disabled]="creating()" (click)="create()">
              @if (creating()) { <span class="loading loading-spinner loading-xs"></span> }
              Create
            </button>
          </div>
        </div>
      </div>

      <!-- Grouped table -->
      @if (loading()) {
        <div class="space-y-2">
          @for (i of [1,2,3]; track i) {
            <oc-skeleton cls="h-10 w-full" />
            <oc-skeleton cls="h-8 w-full" />
            <oc-skeleton cls="h-8 w-full" />
          }
        </div>
      } @else if (tasks().length === 0) {
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body items-center text-center">
            <p class="text-base-content/70">No tasks yet — create one above.</p>
          </div>
        </div>
      } @else {
        <div class="card bg-base-200 border border-base-300 overflow-hidden">
          <div class="overflow-x-auto">
            <table class="table table-sm">
              <thead class="bg-base-300/50">
                <tr>
                  <th class="w-8"></th>
                  <th>Task</th>
                  <th class="hidden md:table-cell">Title</th>
                  <th>Agent</th>
                  <th class="hidden sm:table-cell">Type</th>
                  <th class="hidden lg:table-cell">Updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (ph of phases; track ph) {
                  @let rows = byPhase(ph);
                  <tr class="bg-base-300/30 cursor-pointer select-none hover:bg-base-300/50" (click)="toggle(ph)">
                    <td class="w-8 text-center">
                      <span class="inline-block transition-transform" [class.rotate-90]="!collapsed().has(ph)">▶</span>
                    </td>
                    <td colspan="6">
                      <div class="flex items-center gap-3">
                        <span class="text-xs font-bold uppercase tracking-wider" [class]="phaseTextColor(ph)">{{ ph }}</span>
                        <span class="badge badge-ghost badge-sm">{{ rows.length }}</span>
                        @if (hasCheckpoint(ph)) {
                          <span class="badge badge-warning badge-xs">! checkpoint</span>
                        }
                      </div>
                    </td>
                  </tr>
                  @if (!collapsed().has(ph)) {
                    @if (rows.length === 0) {
                      <tr>
                        <td></td>
                        <td colspan="6" class="text-xs text-base-content/40 italic">empty</td>
                      </tr>
                    } @else {
                      @for (t of rows; track t.id) {
                        <tr class="hover cursor-pointer" (click)="goto(t)">
                          <td></td>
                          <td>
                            <div class="flex items-center gap-2">
                              <span class="font-mono text-sm font-semibold">{{ t.id }}</span>
                              @if (t.checkpointPending) {
                                <span class="badge badge-warning badge-xs" title="Checkpoint pending">!</span>
                              }
                            </div>
                          </td>
                          <td class="hidden md:table-cell">
                            <span class="text-sm text-base-content/80 line-clamp-1">{{ t.title || '(no title)' }}</span>
                          </td>
                          <td>
                            @if (t.assignedAgent) {
                              <span class="badge badge-outline badge-sm">{{ t.assignedAgent }}</span>
                            } @else {
                              <span class="text-base-content/40">—</span>
                            }
                          </td>
                          <td class="hidden sm:table-cell">
                            @if (t.taskType) {
                              <span class="badge badge-ghost badge-sm">{{ t.taskType }}</span>
                            }
                          </td>
                          <td class="hidden lg:table-cell text-xs text-base-content/60">{{ t.updatedAt }}</td>
                          <td class="text-right">
                            <a
                              [routerLink]="['/projects', slug(), 'tasks', t.id]"
                              class="btn btn-xs btn-ghost"
                              (click)="$event.stopPropagation()"
                            >Open →</a>
                          </td>
                        </tr>
                      }
                    }
                  }
                }
              </tbody>
            </table>
          </div>
        </div>
      }
    </div>
  `,
})
export class TasksComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private router = inject(Router);

  slug = input.required<string>();
  tasks = signal<TaskSummary[]>([]);
  phases = PHASES;
  loading = signal(true);
  creating = signal(false);
  query = '';
  newDesc = '';
  newAgent = '';
  collapsed = signal<Set<string>>(new Set(COLLAPSED_PHASES_DEFAULT));

  filtered = computed(() => {
    const q = this.query.toLowerCase().trim();
    if (!q) return this.tasks();
    return this.tasks().filter((t) =>
      t.id.toLowerCase().includes(q) ||
      (t.title ?? '').toLowerCase().includes(q) ||
      (t.assignedAgent ?? '').toLowerCase().includes(q) ||
      (t.taskType ?? '').toLowerCase().includes(q),
    );
  });

  openCount = computed(() => this.tasks().filter((t) => t.phase !== 'DONE' && t.phase !== 'QA_DONE').length);
  doneCount = computed(() => this.tasks().filter((t) => t.phase === 'DONE' || t.phase === 'QA_DONE').length);
  checkpointCount = computed(() => this.tasks().filter((t) => t.checkpointPending).length);

  byPhase(ph: string): TaskSummary[] {
    return this.filtered().filter((t) => t.phase === ph);
  }

  hasCheckpoint(ph: string): boolean {
    return this.byPhase(ph).some((t) => t.checkpointPending);
  }

  toggle(ph: string) {
    const next = new Set(this.collapsed());
    if (next.has(ph)) next.delete(ph); else next.add(ph);
    this.collapsed.set(next);
  }

  goto(t: TaskSummary) {
    this.router.navigate(['/projects', this.slug(), 'tasks', t.id]);
  }

  phaseTextColor(ph: string): string {
    const badge = PHASE_BADGE[ph] ?? PHASE_BADGE['UNKNOWN'];
    return badge.replace('badge-', 'text-');
  }

  ngOnInit() { this.refresh(); }

  refresh() {
    this.loading.set(true);
    this.api.tasks(this.slug()).subscribe({
      next: (t) => { this.tasks.set(t); this.loading.set(false); },
      error: (err) => {
        this.loading.set(false);
        this.toast.error(err?.error?.error || 'Failed to load tasks');
      },
    });
  }

  create() {
    if (!this.newDesc.trim()) return;
    this.creating.set(true);
    this.api.createTask({
      project: this.slug(),
      description: this.newDesc.trim(),
      agentId: this.newAgent.trim() || undefined,
    }).subscribe({
      next: () => {
        this.newDesc = '';
        this.creating.set(false);
        this.toast.success('Task created');
        this.refresh();
      },
      error: (err) => {
        this.creating.set(false);
        this.toast.error(err?.error?.error || 'Create failed');
      },
    });
  }
}
