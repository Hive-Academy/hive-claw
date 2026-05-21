import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ApiService, ProjectSummary } from '../services/api.service';
import { SkeletonComponent } from '../components/skeleton.component';
import { ToastService } from '../services/toast.service';

@Component({
  selector: 'oc-projects',
  standalone: true,
  imports: [RouterLink, FormsModule, SkeletonComponent],
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
          <button class="btn btn-sm btn-primary" (click)="openCreateModal()">New Project</button>
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
            <p class="text-base-content/60 text-sm">No projects yet. Use the <strong>New Project</strong> button above to create one.</p>
          </div>
        </div>
      } @else {
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          @for (p of filtered(); track p.slug) {
            <div class="relative group">
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
              <button
                class="btn btn-xs btn-error btn-outline absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity z-10"
                (click)="openDeleteModal(p, $event)">
                ✕
              </button>
            </div>
          }
        </div>
      }

      <!-- Create modal -->
      @if (showCreateModal()) {
        <dialog open class="modal modal-open">
          <div class="modal-box">
            <h3 class="font-bold text-lg">New Project</h3>
            <div class="form-control mt-4">
              <label class="label"><span class="label-text">Slug <span class="text-error">*</span></span></label>
              <input [(ngModel)]="newSlug" type="text" placeholder="my-project" class="input input-bordered input-sm" />
              <label class="label"><span class="label-text-alt text-base-content/50">kebab-case, a-z0-9, max 64 chars</span></label>
            </div>
            <div class="form-control mt-2">
              <label class="label"><span class="label-text">Name <span class="text-error">*</span></span></label>
              <input [(ngModel)]="newName" type="text" placeholder="My Project" class="input input-bordered input-sm" />
            </div>
            <div class="form-control mt-2">
              <label class="label"><span class="label-text">Workspace path</span></label>
              <input [(ngModel)]="newWorkspace" type="text" placeholder="/home/user/my-project" class="input input-bordered input-sm" />
            </div>
            @if (createError()) {
              <div class="alert alert-error mt-3 text-sm py-2">{{ createError() }}</div>
            }
            <div class="modal-action">
              <button class="btn btn-ghost btn-sm" (click)="closeCreateModal()">Cancel</button>
              <button class="btn btn-primary btn-sm" [disabled]="creating()" (click)="submitCreate()">
                @if (creating()) { <span class="loading loading-spinner loading-xs"></span> }
                Create
              </button>
            </div>
          </div>
          <div class="modal-backdrop" (click)="closeCreateModal()"></div>
        </dialog>
      }

      <!-- Delete modal -->
      @if (showDeleteModal()) {
        <dialog open class="modal modal-open">
          <div class="modal-box">
            <h3 class="font-bold text-lg text-error">Delete project?</h3>
            <p class="mt-2">Are you sure you want to delete <span class="font-mono font-bold">{{ deleteTarget()?.slug }}</span>?</p>
            <p class="text-sm text-base-content/60 mt-1">This action cannot be undone.</p>
            <div class="modal-action">
              <button class="btn btn-ghost btn-sm" (click)="closeDeleteModal()">Cancel</button>
              <button class="btn btn-error btn-sm" [disabled]="deleting()" (click)="confirmDelete()">
                @if (deleting()) { <span class="loading loading-spinner loading-xs"></span> }
                Delete
              </button>
            </div>
          </div>
          <div class="modal-backdrop" (click)="closeDeleteModal()"></div>
        </dialog>
      }
    </div>
  `,
})
export class ProjectsComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  projects = signal<ProjectSummary[]>([]);
  loading = signal(true);
  query = signal('');

  showCreateModal = signal(false);
  showDeleteModal = signal(false);
  deleteTarget = signal<ProjectSummary | null>(null);
  creating = signal(false);
  deleting = signal(false);
  newSlug = '';
  newName = '';
  newWorkspace = '';
  createError = signal('');

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

  openCreateModal() {
    this.newSlug = ''; this.newName = ''; this.newWorkspace = '';
    this.createError.set('');
    this.showCreateModal.set(true);
  }

  closeCreateModal() {
    this.showCreateModal.set(false);
    this.newSlug = ''; this.newName = ''; this.newWorkspace = '';
    this.createError.set('');
  }

  submitCreate() {
    const slug = this.newSlug.trim();
    const name = this.newName.trim();
    if (!slug) { this.createError.set('Slug is required'); return; }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
      this.createError.set('Slug must be lowercase letters, numbers, and hyphens (max 64 chars)');
      return;
    }
    if (!name) { this.createError.set('Name is required'); return; }
    this.creating.set(true);
    this.createError.set('');
    this.api.createProject({ slug, name, workspace: this.newWorkspace.trim() || undefined }).subscribe({
      next: () => {
        this.creating.set(false);
        this.closeCreateModal();
        this.reload();
      },
      error: (err) => {
        this.creating.set(false);
        if (err?.status === 409) {
          this.createError.set('A project with that slug already exists');
        } else {
          this.createError.set(err?.error?.error ?? 'Create failed');
        }
      },
    });
  }

  openDeleteModal(p: ProjectSummary, event: Event) {
    event.preventDefault();
    event.stopPropagation();
    this.deleteTarget.set(p);
    this.showDeleteModal.set(true);
  }

  closeDeleteModal() {
    this.showDeleteModal.set(false);
    this.deleteTarget.set(null);
  }

  confirmDelete() {
    const target = this.deleteTarget();
    if (!target) return;
    this.deleting.set(true);
    this.api.deleteProject(target.slug).subscribe({
      next: () => {
        this.deleting.set(false);
        this.closeDeleteModal();
        this.projects.update((list) => list.filter((p) => p.slug !== target.slug));
      },
      error: (err) => {
        this.deleting.set(false);
        this.toast.error(err?.error?.error ?? 'Delete failed');
        this.closeDeleteModal();
      },
    });
  }

  reload() {
    this.api.projects().subscribe({
      next: (p) => this.projects.set(p),
      error: () => this.toast.error('Failed to reload projects'),
    });
  }
}
