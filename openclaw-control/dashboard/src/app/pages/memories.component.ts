import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, MemoryEntry } from '../services/api.service';
import { ToastService } from '../services/toast.service';
import { SkeletonComponent } from '../components/skeleton.component';

const SCOPES = ['agents', 'users', 'projects', 'threads'] as const;
type Scope = (typeof SCOPES)[number];

@Component({
  selector: 'oc-memories',
  standalone: true,
  imports: [FormsModule, SkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-4">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 class="text-2xl font-bold">Memories</h1>
        <input
          type="text"
          placeholder="Filter ids..."
          class="input input-sm input-bordered w-full sm:w-56"
          [value]="query()"
          (input)="query.set($any($event.target).value)"
        />
      </div>

      <p class="text-sm text-base-content/60">
        Shared memory tree under <kbd class="kbd kbd-sm">~/.claude/shared-memory/</kbd>.
        Persona/secret files for owned agents are stored locally and never synced.
      </p>

      <div class="grid grid-cols-1 lg:grid-cols-[200px_320px_1fr] gap-4">
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body p-3">
            <h2 class="card-title text-sm mb-2">Scope</h2>
            <ul class="menu menu-sm bg-base-200 rounded-box p-0 w-full">
              @for (s of scopes; track s) {
                <li>
                  <a [class.menu-active]="scope() === s" (click)="selectScope(s)">{{ s }}</a>
                </li>
              }
            </ul>
          </div>
        </div>

        <div class="card bg-base-200 border border-base-300">
          <div class="card-body p-3">
            <div class="flex items-center justify-between mb-2">
              <h2 class="card-title text-sm">{{ scope() }}</h2>
              <span class="badge badge-ghost badge-sm">{{ filtered().length }}</span>
            </div>

            <div class="space-y-2 mb-3">
              <input
                type="text"
                [(ngModel)]="newId"
                placeholder="new id (e.g. discord-user-id)"
                class="input input-sm input-bordered w-full"
              />
              <input
                type="text"
                [(ngModel)]="newFile"
                placeholder="filename (profile.md)"
                class="input input-sm input-bordered w-full"
              />
              <button class="btn btn-sm btn-primary w-full" (click)="newEntry()">New file</button>
            </div>

            <div class="divider my-1"></div>

            @if (loading()) {
              <div class="space-y-2">
                @for (i of [1,2,3]; track i) {
                  <div class="space-y-1">
                    <oc-skeleton cls="h-4 w-1/2" />
                    <oc-skeleton cls="h-3 w-full" />
                    <oc-skeleton cls="h-3 w-3/4" />
                  </div>
                }
              </div>
            } @else if (filtered().length === 0) {
              <p class="text-sm text-base-content/50">No entries in this scope.</p>
            } @else {
              <div class="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
                @for (e of filtered(); track e.id) {
                  <div>
                    <div class="text-sm font-semibold text-primary break-all">{{ e.id }}</div>
                    <div class="space-y-1 mt-1">
                      @for (f of e.files; track f.name) {
                        <button
                          class="w-full text-left flex items-center gap-2 px-2 py-1 rounded hover:bg-base-300 transition-colors"
                          [class.bg-base-300]="currentId() === e.id && currentFile() === f.name"
                          (click)="open(e.id, f.name)"
                        >
                          <span class="text-xs flex-1 truncate">{{ f.name }}</span>
                          @if (f.private) {
                            <span class="badge badge-warning badge-xs">private</span>
                          }
                          <span class="text-xs text-base-content/40">{{ f.size }}b</span>
                        </button>
                      }
                    </div>
                  </div>
                }
              </div>
            }
          </div>
        </div>

        <div class="card bg-base-200 border border-base-300">
          <div class="card-body p-3">
            @if (currentFile()) {
              <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-2">
                <div class="text-sm">
                  <span class="font-mono break-all">{{ scope() }}/{{ currentId() }}/{{ currentFile() }}</span>
                  @if (currentPrivate()) {
                    <span class="badge badge-warning badge-sm ml-2">private (this machine only)</span>
                  }
                </div>
                <div class="flex gap-2">
                  <button class="btn btn-sm btn-primary" [disabled]="saving()" (click)="save()">
                    @if (saving()) { <span class="loading loading-spinner loading-xs"></span> }
                    Save
                  </button>
                  <button class="btn btn-sm btn-error btn-outline" (click)="del()">Delete</button>
                </div>
              </div>

              @if (currentPrivate()) {
                <div class="alert alert-warning alert-soft text-xs mb-2">
                  This file lives in <kbd class="kbd kbd-xs">~/.claude/local-memory/</kbd> on this machine only — never committed to the shared specs repo.
                </div>
              }

              <textarea
                [(ngModel)]="content"
                class="textarea textarea-bordered font-mono text-sm w-full min-h-[480px]"
                spellcheck="false"
              ></textarea>
            } @else {
              <div class="flex items-center justify-center min-h-[480px]">
                <p class="text-sm text-base-content/50">Pick a file on the left to view or edit its content.</p>
              </div>
            }
          </div>
        </div>
      </div>
    </div>
  `,
})
export class MemoriesComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  scopes = SCOPES;
  scope = signal<Scope>('users');
  entries = signal<MemoryEntry[]>([]);
  loading = signal(true);
  query = signal('');

  currentId = signal<string>('');
  currentFile = signal<string>('');
  currentPrivate = signal<boolean>(false);
  content = '';
  newId = '';
  newFile = '';
  saving = signal(false);

  filtered = computed(() => {
    const q = this.query().toLowerCase().trim();
    const list = this.entries();
    if (!q) return list;
    return list.filter((e) =>
      e.id.toLowerCase().includes(q) ||
      e.files.some((f) => f.name.toLowerCase().includes(q)),
    );
  });

  ngOnInit() {
    this.refresh();
  }

  selectScope(s: Scope) {
    this.scope.set(s);
    this.currentId.set('');
    this.currentFile.set('');
    this.content = '';
    this.refresh();
  }

  refresh() {
    this.loading.set(true);
    this.api.memories(this.scope()).subscribe({
      next: (e) => { this.entries.set(e); this.loading.set(false); },
      error: (err) => {
        this.loading.set(false);
        this.toast.error(err?.error?.error || `Failed to load ${this.scope()} memories`);
      },
    });
  }

  open(id: string, file: string) {
    this.currentId.set(id);
    this.currentFile.set(file);
    this.api.readMemory(this.scope(), id, file).subscribe({
      next: (r) => {
        this.content = r.content;
        this.currentPrivate.set(r.private);
      },
      error: (err) => this.toast.error(err?.error?.error || 'Failed to read file'),
    });
  }

  save() {
    if (!this.currentId() || !this.currentFile()) return;
    this.saving.set(true);
    this.api.writeMemory(this.scope(), this.currentId(), this.currentFile(), this.content).subscribe({
      next: () => {
        this.saving.set(false);
        this.toast.success('Saved');
        this.refresh();
      },
      error: (err) => {
        this.saving.set(false);
        this.toast.error(err?.error?.error || 'Save failed');
      },
    });
  }

  del() {
    if (!this.currentId() || !this.currentFile()) return;
    this.api.deleteMemory(this.scope(), this.currentId(), this.currentFile()).subscribe({
      next: () => {
        this.toast.success('Deleted');
        this.currentFile.set('');
        this.content = '';
        this.refresh();
      },
      error: (err) => this.toast.error(err?.error?.error || 'Delete failed'),
    });
  }

  newEntry() {
    const id = this.newId.trim();
    const file = this.newFile.trim();
    if (!id || !file) {
      this.toast.warning('Need both id and filename');
      return;
    }
    this.api.writeMemory(this.scope(), id, file, '').subscribe({
      next: () => {
        this.currentId.set(id);
        this.currentFile.set(file);
        this.newId = '';
        this.newFile = '';
        this.content = '';
        this.toast.success('Created');
        this.refresh();
      },
      error: (err) => this.toast.error(err?.error?.error || 'Create failed'),
    });
  }
}
