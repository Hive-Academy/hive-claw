import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService, ProjectSummary } from '../services/api.service';
import { SkeletonComponent } from '../components/skeleton.component';

@Component({
  selector: 'oc-projects',
  standalone: true,
  imports: [RouterLink, SkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-4">
      <!-- Header + stats -->
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 class="text-2xl font-bold">Projects</h1>
        <div class="flex gap-2">
          <input
            type="text"
            placeholder="Search projects..."
            class="input input-sm input-bordered w-full sm:w-64"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
        </div>
      </div>

      <!-- Stats -->
      @if (!loading()) {
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div class="stat bg-base-200 rounded-box p-3">
            <div class="stat-title text-xs">Projects</div>
            <div class="stat-value text-lg">{{ projects().length }}</div>
          </div>
          <div class="stat bg-base-200 rounded-box p-3">
            <div class="stat-title text-xs">Open tasks</div>
            <div class="stat-value text-lg">{{ totalOpen() }}</div>
          </div>
          <div class="stat bg-base-200 rounded-box p-3">
            <div class="stat-title text-xs">Total tasks</div>
            <div class="stat-value text-lg">{{ totalTasks() }}</div>
          </div>
          <div class="stat bg-base-200 rounded-box p-3">
            <div class="stat-title text-xs">Checkpoints</div>
            <div class="stat-value text-lg text-warning">{{ totalCheckpoints() }}</div>
          </div>
        </div>
      }

      <!-- Grid -->
      @if (loading()) {
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          @for (i of [1,2,3,4,5,6]; track i) {
            <div class="card bg-base-200 border border-base-300">
              <div class="card-body gap-3">
                <oc-skeleton cls="h-5 w-1/2" />
                <oc-skeleton cls="h-3 w-full" />
                <oc-skeleton cls="h-3 w-2/3" />
              </div>
            </div>
          }
        </div>
      } @else if (filtered().length === 0) {
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body">
            <p>No projects found.</p>
            <p class="text-base-content/60 text-sm">Set <kbd class="kbd kbd-sm">OPENCLAW_PROJECT_ROOTS</kbd> to colon-separated dirs to scan.</p>
          </div>
        </div>
      } @else {
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          @for (p of filtered(); track p.slug) {
            <a class="card bg-base-200 border border-base-300 hover:border-primary hover:shadow-lg transition-all group"
              [routerLink]="['/projects', p.slug]">
              <div class="card-body">
                <div class="flex items-start justify-between">
                  <span class="text-lg font-semibold text-primary group-hover:underline">{{ p.slug }}</span>
                  @if (p.checkpointCount > 0) {
                    <span class="badge badge-warning badge-sm">{{ p.checkpointCount }} checkpoint{{ p.checkpointCount > 1 ? 's' : '' }}</span>
                  }
                </div>
                <div class="text-xs text-base-content/50 break-all mt-1">{{ p.path }}</div>
                <div class="flex items-center gap-3 mt-3 text-sm">
                  <div class="flex items-center gap-1">
                    <span class="w-2 h-2 rounded-full bg-success"></span>
                    <span>{{ p.openTaskCount }} open</span>
                  </div>
                  <div class="text-base-content/30">/</div>
                  <div class="text-base-content/60">{{ p.taskCount }} total</div>
                </div>
              </div>
            </a>
          }
        </div>
      }
    </div>
  `,
})
export class ProjectsComponent implements OnInit {
  private api = inject(ApiService);
  projects = signal<ProjectSummary[]>([]);
  loading = signal(true);
  query = signal('');

  filtered = computed(() => {
    const q = this.query().toLowerCase().trim();
    if (!q) return this.projects();
    return this.projects().filter((p) => p.slug.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
  });

  totalOpen = computed(() => this.projects().reduce((s, p) => s + p.openTaskCount, 0));
  totalTasks = computed(() => this.projects().reduce((s, p) => s + p.taskCount, 0));
  totalCheckpoints = computed(() => this.projects().reduce((s, p) => s + p.checkpointCount, 0));

  ngOnInit() {
    this.api.projects().subscribe({
      next: (p) => { this.projects.set(p); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }
}
