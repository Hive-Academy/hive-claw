import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ApiService, TaskDetail } from '../services/api.service';
import { SseService } from '../services/sse.service';
import { ToastService } from '../services/toast.service';
import { SkeletonComponent } from '../components/skeleton.component';
import { MarkdownComponent } from '../components/markdown.component';
import { LogEntryComponent } from '../components/log-entry.component';
import type { Dispatch, TaskFileMeta } from '../models/index';

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

const MD_EXTS = ['.md', '.markdown', '.mdx'];
const JSON_EXTS = ['.json'];
const YAML_EXTS = ['.yaml', '.yml'];

@Component({
  selector: 'oc-task-detail',
  standalone: true,
  imports: [RouterLink, FormsModule, SkeletonComponent, MarkdownComponent, LogEntryComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-4">
      @if (task(); as t) {
        <!-- Header -->
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <a [routerLink]="['/projects', slug()]" class="text-sm text-primary hover:underline">← {{ slug() }}</a>
            <h1 class="text-2xl font-bold mt-1">{{ t.id }}</h1>
          </div>
          <div class="flex flex-wrap gap-2">
            <span class="badge" [class]="phaseBadge(t.phase)">{{ t.phase }}</span>
            @if (t.assignedAgent) { <span class="badge badge-outline">{{ t.assignedAgent }}</span> }
            @if (t.discordUserId) { <span class="badge badge-outline">user: {{ t.discordUserId }}</span> }
            @if (t.taskType) { <span class="badge badge-ghost">{{ t.taskType }}</span> }
            @if (noProgressStreak() >= 1) {
              <span class="badge" [class]="noProgressStreak() >= 2 ? 'badge-error' : 'badge-warning'" title="Consecutive dispatches produced no observable change">
                no-progress streak: {{ noProgressStreak() }}
              </span>
            }
          </div>
        </div>

        <!-- Checkpoint banner -->
        @if (t.checkpointPending) {
          <div class="alert alert-warning">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
            <div class="flex-1">
              <div class="font-bold">USER VALIDATION CHECKPOINT — phase {{ t.phase }}</div>
              <div class="text-sm">Approve to enable the Advance button for the next phase.</div>
              <textarea
                [(ngModel)]="feedback"
                placeholder="optional feedback / revision notes"
                class="textarea textarea-bordered w-full mt-2 text-sm min-h-[80px]"
              ></textarea>
              <div class="flex flex-wrap gap-2 mt-2">
                <button class="btn btn-sm btn-success" [disabled]="acting()" (click)="approve(t.phase)">
                  @if (acting() === 'approve') { <span class="loading loading-spinner loading-xs"></span> }
                  Approve
                </button>
                <button class="btn btn-sm btn-error btn-outline" [disabled]="acting()" (click)="reject(t.phase)">
                  @if (acting() === 'reject') { <span class="loading loading-spinner loading-xs"></span> }
                  Reject
                </button>
              </div>
              <p class="text-xs text-base-content/70 mt-2">
                Approval only records consent — it does not start the next phase. Click <span class="font-semibold">Run phase</span> below when you're ready.
              </p>
            </div>
          </div>
        }

        <!-- Main grid: content + right sidebar -->
        <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4">

          <!-- Main column -->
          <div class="space-y-4 min-w-0">

            <!-- Overview / actions card -->
            <div class="card bg-base-200 border border-base-300">
              <div class="card-body p-4 space-y-3">
                <div class="flex items-center justify-between">
                  <h2 class="card-title text-base">Overview</h2>
                  <button class="btn btn-xs btn-ghost" (click)="refresh()" title="Refresh">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                  </button>
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div><span class="text-base-content/50">ID:</span> <span class="font-mono">{{ t.id }}</span></div>
                  <div><span class="text-base-content/50">Phase:</span> {{ t.phase }}</div>
                  <div><span class="text-base-content/50">Agent:</span> {{ t.assignedAgent ?? '—' }}</div>
                  <div><span class="text-base-content/50">Updated:</span> <span class="text-xs">{{ t.updatedAt }}</span></div>
                </div>
                <div class="flex flex-wrap items-end gap-2 pt-2 border-t border-base-300">
                  <input [(ngModel)]="handoffTo" placeholder="Handoff to agent..." class="input input-sm input-bordered w-48" />
                  <button class="btn btn-sm btn-primary" [disabled]="acting() || !handoffTo.trim()" (click)="handoff()">
                    @if (acting() === 'handoff') { <span class="loading loading-spinner loading-xs"></span> }
                    Handoff
                  </button>
                </div>
              </div>
            </div>

            <!-- HITL Phase actions (TASK_2026_004) — the only entry point that creates an LLM dispatch -->
            <div class="card bg-base-200 border border-base-300">
              <div class="card-body p-4">
                <div class="flex items-center justify-between mb-2">
                  <h2 class="card-title text-base">Phase actions</h2>
                  <span class="badge badge-sm badge-ghost">HITL</span>
                </div>
                <p class="text-xs text-base-content/60 mb-3">
                  No work runs automatically. Each click here creates exactly one dispatch for phase <span class="font-mono font-semibold">{{ t.phase }}</span>.
                </p>
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm mb-3">
                  <div><span class="text-base-content/50">Open dispatches:</span> <span class="font-semibold" [class.text-warning]="openDispatchCount() > 0">{{ openDispatchCount() }}</span></div>
                  <div><span class="text-base-content/50">Lifetime:</span> <span class="font-semibold" [class.text-warning]="(t.dispatchCount) >= 10">{{ t.dispatchCount }}</span></div>
                  <div>
                    <span class="text-base-content/50">Budget:</span>
                    <span class="badge badge-sm" [class]="budgetExhausted() ? 'badge-error' : ((t.dispatchCount) >= (t.dispatchBudget ?? 20) * 0.8 ? 'badge-warning' : 'badge-ghost')">
                      {{ t.dispatchCount }} / {{ t.dispatchBudget ?? 20 }}
                    </span>
                  </div>
                  <div><span class="text-base-content/50">Last:</span> {{ lastDispatchSummary() }}</div>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button class="btn btn-sm btn-primary" [disabled]="advancing() || acknowledging() || t.phase === 'DONE' || noProgressStreak() >= 2" (click)="openAdvanceConfirm()">
                    @if (advancing()) { <span class="loading loading-spinner loading-xs"></span> }
                    Run phase {{ t.phase }}
                  </button>
                  @if (noProgressStreak() >= 2) {
                    <button class="btn btn-sm btn-warning" [disabled]="acknowledging()" (click)="acknowledgeAndForceAdvance()">
                      @if (acknowledging()) { <span class="loading loading-spinner loading-xs"></span> }
                      Acknowledge &amp; force advance
                    </button>
                  }
                  @if (budgetExhausted() || (t.dispatchCount) >= (t.dispatchBudget ?? 20) * 0.8) {
                    <button class="btn btn-sm btn-outline btn-info" [disabled]="toppingUp()" (click)="topUpBudget()">
                      @if (toppingUp()) { <span class="loading loading-spinner loading-xs"></span> }
                      Top up budget (+{{ budgetDelta() }})
                    </button>
                  }
                  <button class="btn btn-sm btn-error btn-outline" [disabled]="cancelling() || openDispatchCount() === 0" (click)="cancelPending()">
                    @if (cancelling()) { <span class="loading loading-spinner loading-xs"></span> }
                    Cancel pending ({{ openDispatchCount() }})
                  </button>
                </div>
              </div>
            </div>

            <!-- Advance confirmation modal -->
            @if (advanceConfirmOpen()) {
              <div class="modal modal-open">
                <div class="modal-box max-w-2xl">
                  <h3 class="font-bold text-lg">Run phase {{ t.phase }}?</h3>
                  <div class="text-sm space-y-2 mt-3">
                    <div><span class="text-base-content/50">Task:</span> <span class="font-mono">{{ t.id }}</span></div>
                    <div><span class="text-base-content/50">Agent:</span> <span class="font-mono">{{ t.assignedAgent ?? 'anubis' }}</span></div>
                    <div><span class="text-base-content/50">This will create:</span> exactly one pending dispatch (or run inline if owned here).</div>
                  </div>
                  <details class="mt-3">
                    <summary class="cursor-pointer text-sm text-primary hover:underline select-none">Show prompt preview</summary>
                    <pre class="mt-2 bg-base-300 rounded p-3 text-xs max-h-[40vh] overflow-y-auto whitespace-pre-wrap">{{ advancePromptPreview() }}</pre>
                  </details>
                  <div class="modal-action">
                    <button class="btn btn-sm btn-ghost" (click)="closeAdvanceConfirm()">Cancel</button>
                    <button class="btn btn-sm btn-primary" [disabled]="advancing()" (click)="confirmAdvance()">
                      @if (advancing()) { <span class="loading loading-spinner loading-xs"></span> }
                      Yes, run phase
                    </button>
                  </div>
                </div>
                <div class="modal-backdrop" (click)="closeAdvanceConfirm()"></div>
              </div>
            }

            <!-- Selected file preview (appears when sidebar item clicked) -->
            @if (currentFileName(); as fname) {
              <div class="card bg-base-200 border border-primary/40">
                <div class="card-body p-4">
                  <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="text-xs uppercase text-primary tracking-wider">file</span>
                      <span class="font-mono text-sm font-semibold truncate">{{ fname }}</span>
                      <span class="badge badge-xs badge-ghost">{{ fileLanguage() }}</span>
                    </div>
                    <div class="flex flex-wrap gap-2">
                      <div class="join">
                        <button
                          class="btn btn-xs join-item"
                          [class.btn-primary]="fileMode() === 'preview'"
                          [class.btn-ghost]="fileMode() !== 'preview'"
                          (click)="fileMode.set('preview')"
                        >Preview</button>
                        <button
                          class="btn btn-xs join-item"
                          [class.btn-primary]="fileMode() === 'edit'"
                          [class.btn-ghost]="fileMode() !== 'edit'"
                          (click)="fileMode.set('edit')"
                        >Edit</button>
                      </div>
                      <button class="btn btn-xs btn-ghost" (click)="copy(currentFileContent)">Copy</button>
                      <button class="btn btn-xs btn-ghost" (click)="closeFile()">Close</button>
                    </div>
                  </div>

                  @if (fileLoading()) {
                    <oc-skeleton cls="h-32 w-full" />
                  } @else if (fileMode() === 'preview') {
                    @if (fileLanguage() === 'markdown') {
                      <oc-md [source]="currentFileContent" />
                    } @else if (fileLanguage() === 'json') {
                      <pre class="bg-base-300 rounded-lg p-3 overflow-auto text-xs max-h-[60vh]">{{ prettyJson(currentFileContent) }}</pre>
                    } @else {
                      <pre class="bg-base-300 rounded-lg p-3 overflow-auto text-xs max-h-[60vh] whitespace-pre-wrap">{{ currentFileContent }}</pre>
                    }
                  } @else {
                    <textarea
                      [(ngModel)]="currentFileContent"
                      class="textarea textarea-bordered w-full font-mono text-xs min-h-[40vh]"
                      spellcheck="false"
                    ></textarea>
                  }

                  <div class="flex justify-end gap-2 mt-3">
                    <button class="btn btn-sm btn-error btn-outline" (click)="deleteFile()">Delete</button>
                    <button class="btn btn-sm btn-primary" [disabled]="savingFile()" (click)="saveFile()">
                      @if (savingFile()) { <span class="loading loading-spinner loading-xs"></span> }
                      Save
                    </button>
                  </div>
                </div>
              </div>
            }

            <!-- Artifacts (markdown rendered) -->
            <div class="card bg-base-200 border border-base-300">
              <div class="card-body p-4">
                <h2 class="card-title text-base mb-2">Artifacts</h2>
                @if (artifactList().length === 0) {
                  <p class="text-sm text-base-content/50">No artifacts yet.</p>
                } @else {
                  <div class="space-y-3">
                    @for (entry of artifactList(); track entry.name) {
                      <div class="border border-base-300 rounded-lg overflow-hidden bg-base-100">
                        <div class="flex items-center justify-between px-3 py-2 bg-base-300/40 border-b border-base-300">
                          <div class="flex items-center gap-2">
                            <button
                              class="btn btn-xs btn-ghost btn-square"
                              (click)="toggleArtifact(entry.name)"
                              [title]="isArtifactCollapsed(entry.name) ? 'Expand' : 'Collapse'"
                            >
                              <span class="inline-block transition-transform" [class.rotate-90]="!isArtifactCollapsed(entry.name)">▶</span>
                            </button>
                            <span class="font-mono text-sm font-semibold">{{ entry.name }}</span>
                            <span class="badge badge-xs badge-ghost">{{ artifactLanguage(entry.name) }}</span>
                          </div>
                          <div class="flex gap-1">
                            <div class="join">
                              <button
                                class="btn btn-xs join-item"
                                [class.btn-primary]="artifactMode(entry.name) === 'preview'"
                                [class.btn-ghost]="artifactMode(entry.name) !== 'preview'"
                                (click)="setArtifactMode(entry.name, 'preview')"
                              >Preview</button>
                              <button
                                class="btn btn-xs join-item"
                                [class.btn-primary]="artifactMode(entry.name) === 'raw'"
                                [class.btn-ghost]="artifactMode(entry.name) !== 'raw'"
                                (click)="setArtifactMode(entry.name, 'raw')"
                              >Raw</button>
                            </div>
                            <button class="btn btn-xs btn-ghost" (click)="copy(entry.content)">Copy</button>
                          </div>
                        </div>
                        @if (!isArtifactCollapsed(entry.name)) {
                          <div class="p-4">
                            @if (artifactMode(entry.name) === 'preview') {
                              @if (artifactLanguage(entry.name) === 'markdown') {
                                <oc-md [source]="entry.content" />
                              } @else if (artifactLanguage(entry.name) === 'json') {
                                <pre class="bg-base-300 rounded-lg p-3 overflow-auto text-xs max-h-[60vh]">{{ prettyJson(entry.content) }}</pre>
                              } @else {
                                <pre class="bg-base-300 rounded-lg p-3 overflow-auto text-xs max-h-[60vh] whitespace-pre-wrap">{{ entry.content }}</pre>
                              }
                            } @else {
                              <pre class="bg-base-300 rounded-lg p-3 overflow-auto text-xs max-h-[60vh]">{{ entry.content }}</pre>
                            }
                          </div>
                        }
                      </div>
                    }
                  </div>
                }
              </div>
            </div>

            <!-- Dispatches -->
            <div class="card bg-base-200 border border-base-300">
              <div class="card-body p-4">
                <h2 class="card-title text-base mb-2">Dispatches</h2>
                <div class="overflow-x-auto">
                  <table class="table table-sm">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Phase</th>
                        <th>Agent</th>
                        <th>State</th>
                        <th>Exit</th>
                        <th>Duration</th>
                        <th>Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      @if (dispatchesLoading()) {
                        <tr><td colspan="7"><oc-skeleton cls="h-4 w-full" /></td></tr>
                      } @else if (dispatches().length === 0) {
                        <tr><td colspan="7" class="text-center text-base-content/50 py-3">No dispatches for this task.</td></tr>
                      } @else {
                        @for (d of dispatches(); track d.id) {
                          <tr class="hover">
                            <td class="font-mono text-xs">{{ d.id.slice(0, 8) }}</td>
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
              </div>
            </div>

            <!-- Logs -->
            <div class="card bg-base-200 border border-base-300">
              <div class="card-body p-4">
                <div class="flex items-center justify-between mb-3">
                  <h2 class="card-title text-base">Logs</h2>
                  <div class="flex items-center gap-2">
                    <span class="text-xs text-base-content/50">{{ taskEvents().length }} events</span>
                    <select
                      class="select select-xs select-bordered"
                      [value]="logFilter()"
                      (change)="logFilter.set($any($event.target).value)"
                    >
                      <option value="all">all events</option>
                      <option value="invoker">invoker only</option>
                      <option value="dispatch">dispatch only</option>
                      <option value="agent">agent messages</option>
                    </select>
                  </div>
                </div>
                <div class="space-y-0.5 max-h-[60vh] overflow-y-auto">
                  @for (e of filteredEvents(); track e.ts + e.type) {
                    <oc-log-entry [type]="e.type" [data]="e.data" [ts]="e.ts" />
                  } @empty {
                    <div class="text-sm text-base-content/50 italic">No events yet.</div>
                  }
                </div>
              </div>
            </div>
          </div>

          <!-- Right sidebar: file navigator -->
          <aside class="lg:sticky lg:top-4 lg:self-start space-y-4">
            <div class="card bg-base-200 border border-base-300">
              <div class="card-body p-3">
                <div class="flex items-center justify-between mb-2">
                  <h2 class="card-title text-sm">Files</h2>
                  <div class="flex gap-1">
                    <button class="btn btn-xs btn-ghost btn-square" title="New file" (click)="newFile()">+</button>
                    <button class="btn btn-xs btn-ghost btn-square" title="Refresh" (click)="loadFiles()">↻</button>
                  </div>
                </div>
                @if (filesLoading()) {
                  <oc-skeleton cls="h-4 w-full" />
                  <oc-skeleton cls="h-4 w-3/4" />
                  <oc-skeleton cls="h-4 w-2/3" />
                } @else if (files().length === 0) {
                  <p class="text-xs text-base-content/50">No files in this task folder.</p>
                } @else {
                  <ul class="menu menu-sm bg-base-200 p-0 w-full">
                    @for (f of files(); track f.filename) {
                      <li>
                        <a
                          [class.menu-active]="currentFileName() === f.filename"
                          (click)="openFile(f.filename)"
                          class="flex items-center justify-between gap-2"
                        >
                          <div class="flex items-center gap-2 min-w-0">
                            <span class="text-xs">{{ fileIcon(f.filename) }}</span>
                            <span class="truncate text-sm">{{ f.filename }}</span>
                          </div>
                          <span class="text-xs text-base-content/40 shrink-0">{{ formatBytes(f.sizeBytes) }}</span>
                        </a>
                      </li>
                    }
                  </ul>
                }
              </div>
            </div>

            <div class="card bg-base-200 border border-base-300">
              <div class="card-body p-3">
                <h2 class="card-title text-sm mb-2">Quick info</h2>
                <div class="text-xs space-y-1">
                  <div><span class="text-base-content/50">Folder:</span> <span class="font-mono break-all">{{ t.folder }}</span></div>
                  @if (t.channelId) {
                    <div><span class="text-base-content/50">Channel:</span> <span class="font-mono">{{ t.channelId }}</span></div>
                  }
                  <div><span class="text-base-content/50">Artifacts:</span> {{ artifactList().length }}</div>
                  <div><span class="text-base-content/50">Dispatches:</span> {{ dispatches().length }}</div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      } @else {
        <div class="space-y-4">
          <oc-skeleton cls="h-8 w-1/3" />
          <oc-skeleton cls="h-24 w-full" />
          <oc-skeleton cls="h-48 w-full" />
        </div>
      }
    </div>
  `,
})
export class TaskDetailComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private sse = inject(SseService);
  private toast = inject(ToastService);

  slug = input.required<string>();
  taskId = input.required<string>();

  task = signal<TaskDetail | null>(null);
  acting = signal<string | null>(null);
  feedback = '';
  handoffTo = '';

  files = signal<TaskFileMeta[]>([]);
  filesLoading = signal(false);
  currentFileName = signal<string>('');
  currentFileContent = '';
  fileLoading = signal(false);
  savingFile = signal(false);
  fileMode = signal<'preview' | 'edit'>('preview');

  dispatches = signal<Dispatch[]>([]);
  dispatchesLoading = signal(false);

  artifactCollapsed = signal<Set<string>>(new Set());
  artifactModes = signal<Map<string, 'preview' | 'raw'>>(new Map());

  logFilter = signal<'all' | 'invoker' | 'dispatch' | 'agent'>('all');

  // HITL Phase actions (TASK_2026_004) — manual-only dispatch + cancel.
  advancing = signal(false);
  cancelling = signal(false);
  advanceConfirmOpen = signal<boolean>(false);
  advancePromptPreview = signal<string>('');
  acknowledging = signal(false);
  toppingUp = signal(false);
  budgetDelta = signal(5);

  artifactList = computed(() => {
    const t = this.task();
    if (!t) return [];
    return Object.entries(t.artifacts).map(([name, content]) => ({ name, content }));
  });

  openDispatchCount = computed(() =>
    this.dispatches().filter((d) => d.state === 'pending' || d.state === 'taken').length,
  );

  noProgressStreak = computed(() => this.task()?.noProgressStreak ?? 0);

  dispatchBudget = computed(() => this.task()?.dispatchBudget ?? 20);

  budgetExhausted = computed(() => {
    const t = this.task();
    if (!t) return false;
    return (t.dispatchCount) >= (t.dispatchBudget ?? 20);
  });

  lastDispatchSummary = computed<string>(() => {
    const ds = this.dispatches();
    if (ds.length === 0) return '—';
    const latest = ds[0];
    return `${latest.state} · ${latest.phase}`;
  });

  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private lastEventCount = 0;

  ngOnInit() {
    this.refresh();
    this.loadFiles();
    this.loadDispatches();
    this.pollHandle = setInterval(() => {
      const evts = this.sse.events();
      const taskHits = evts.filter((e) =>
        e.data?.taskId === this.taskId() || e.data?.project === this.slug(),
      );
      if (taskHits.length !== this.lastEventCount) {
        this.lastEventCount = taskHits.length;
        this.refresh();
        this.loadFiles();
        this.loadDispatches();
      }
    }, 3000);
  }

  ngOnDestroy() {
    if (this.pollHandle) clearInterval(this.pollHandle);
  }

  refresh() {
    this.api.task(this.slug(), this.taskId()).subscribe({
      next: (t) => this.task.set(t),
      error: (err) => this.toast.error(err?.error?.error || 'Failed to load task'),
    });
  }

  approve(phase: string) {
    this.acting.set('approve');
    this.api.approve(this.slug(), this.taskId(), { phase, decision: 'APPROVED', feedback: this.feedback })
      .subscribe({
        next: () => {
          this.feedback = '';
          this.acting.set(null);
          this.toast.success('Approved');
          this.refresh();
        },
        error: (err) => {
          this.acting.set(null);
          this.toast.error(err?.error?.error || 'Approve failed');
        },
      });
  }

  reject(phase: string) {
    this.acting.set('reject');
    this.api.approve(this.slug(), this.taskId(), { phase, decision: 'REJECTED', feedback: this.feedback })
      .subscribe({
        next: () => {
          this.feedback = '';
          this.acting.set(null);
          this.toast.success('Rejected');
          this.refresh();
        },
        error: (err) => {
          this.acting.set(null);
          this.toast.error(err?.error?.error || 'Reject failed');
        },
      });
  }

  handoff() {
    if (!this.handoffTo.trim()) return;
    this.acting.set('handoff');
    this.api.handoff(this.slug(), this.taskId(), this.handoffTo.trim())
      .subscribe({
        next: () => {
          this.handoffTo = '';
          this.acting.set(null);
          this.toast.success('Handoff scheduled');
          this.refresh();
        },
        error: (err) => {
          this.acting.set(null);
          this.toast.error(err?.error?.error || 'Handoff failed');
        },
      });
  }

  // ---- HITL Phase actions (TASK_2026_004) ------------------------------
  // Two-step Advance: openAdvanceConfirm() shows the modal previewing the
  // prompt; confirmAdvance() actually fires the dispatch. The two-step is
  // friction by design — clicking Advance accidentally must not spend
  // money. The modal also doubles as documentation: the operator sees
  // exactly what prompt will be sent before saying yes.

  openAdvanceConfirm() {
    const t = this.task();
    if (!t) return;
    // We'd love to fetch a server-side preview here, but the daemon
    // builds the prompt synchronously on POST and returns it in the
    // response. For the modal we show a generic "what will happen"
    // until the operator confirms; the toast on completion includes the
    // real prompt preview. A future enhancement could add a GET
    // /preview endpoint that returns the prompt without dispatching.
    this.advancePromptPreview.set(
      `Phase: ${t.phase}\nAgent: ${t.assignedAgent ?? 'anubis'}\n\n` +
        `(prompt is composed server-side from context.md + memory; full preview is shown in the toast after dispatch fires.)`,
    );
    this.advanceConfirmOpen.set(true);
  }

  closeAdvanceConfirm() {
    this.advanceConfirmOpen.set(false);
  }

  confirmAdvance() {
    if (this.advancing()) return;
    this.advancing.set(true);
    this.api.advanceTask(this.slug(), this.taskId()).subscribe({
      next: (r) => {
        this.advancing.set(false);
        this.advanceConfirmOpen.set(false);
        if (r.inlined) {
          this.toast.success(`Phase ${r.phase} running inline (${r.agentId})`);
        } else if (r.dispatchId) {
          this.toast.success(`Dispatch ${r.dispatchId.slice(0, 8)} queued for ${r.agentId}`);
        }
        if (r.promptPreview) this.advancePromptPreview.set(r.promptPreview);
        this.refresh();
        this.loadDispatches();
      },
      error: (err) => {
        this.advancing.set(false);
        const code = err?.error?.code;
        const msg = err?.error?.error ?? 'Advance failed';
        if (code === 'E_BUDGET_EXHAUSTED') {
          this.toast.error(`Budget exhausted (${err.error.dispatchCount}/${err.error.dispatchBudget}). Top up budget to continue.`);
        } else {
          this.toast.error(msg);
        }
      },
    });
  }

  cancelPending() {
    if (this.cancelling()) return;
    if (!confirm(`Cancel all open dispatches for ${this.taskId()}?`)) return;
    this.cancelling.set(true);
    this.api.cancelPendingForTask(this.slug(), this.taskId()).subscribe({
      next: (r) => {
        this.cancelling.set(false);
        this.toast.success(`Cancelled ${r.cancelled} dispatch(es)`);
        this.loadDispatches();
        this.refresh();
      },
      error: (err) => {
        this.cancelling.set(false);
        this.toast.error(err?.error?.error || 'Cancel failed');
      },
    });
  }

  acknowledgeAndForceAdvance() {
    if (this.acknowledging()) return;
    this.acknowledging.set(true);
    this.api.acknowledgeNoProgress(this.slug(), this.taskId()).subscribe({
      next: () => {
        // After acknowledging, immediately advance.
        this.api.advanceTask(this.slug(), this.taskId()).subscribe({
          next: (r) => {
            this.acknowledging.set(false);
            if (r.inlined) {
              this.toast.success(`Phase ${r.phase} running inline (${r.agentId})`);
            } else if (r.dispatchId) {
              this.toast.success(`Dispatch ${r.dispatchId.slice(0, 8)} queued for ${r.agentId}`);
            } else {
              this.toast.success('Advance accepted');
            }
            this.refresh();
            this.loadDispatches();
          },
          error: (err) => {
            this.acknowledging.set(false);
            const msg = err?.error?.error ?? 'Advance failed';
            this.toast.error(msg);
          },
        });
      },
      error: (err) => {
        this.acknowledging.set(false);
        this.toast.error(err?.error?.error || 'Acknowledge failed');
      },
    });
  }

  topUpBudget() {
    if (this.toppingUp()) return;
    this.toppingUp.set(true);
    this.api.topUpBudget(this.slug(), this.taskId(), { delta: this.budgetDelta() }).subscribe({
      next: (r) => {
        this.toppingUp.set(false);
        this.toast.success(`Budget topped up to ${r.dispatchBudget}`);
        this.refresh();
      },
      error: (err) => {
        this.toppingUp.set(false);
        this.toast.error(err?.error?.error || 'Budget top-up failed');
      },
    });
  }

  copy(text: string) {
    navigator.clipboard.writeText(text).then(() => this.toast.success('Copied'));
  }

  loadFiles() {
    this.filesLoading.set(true);
    this.api.taskFiles(this.slug(), this.taskId()).subscribe({
      next: (f) => { this.files.set(f); this.filesLoading.set(false); },
      error: () => this.filesLoading.set(false),
    });
  }

  openFile(filename: string) {
    this.currentFileName.set(filename);
    this.fileMode.set('preview');
    this.fileLoading.set(true);
    this.api.readTaskFile(this.slug(), this.taskId(), filename).subscribe({
      next: (r) => { this.currentFileContent = r.content; this.fileLoading.set(false); },
      error: (err) => {
        this.fileLoading.set(false);
        this.currentFileContent = '';
        this.toast.error(err?.error?.error || 'Failed to read file');
      },
    });
  }

  closeFile() {
    this.currentFileName.set('');
    this.currentFileContent = '';
  }

  saveFile() {
    const name = this.currentFileName();
    if (!name) return;
    this.savingFile.set(true);
    this.api.writeTaskFile(this.slug(), this.taskId(), name, this.currentFileContent).subscribe({
      next: () => {
        this.savingFile.set(false);
        this.toast.success('File saved');
        this.loadFiles();
      },
      error: (err) => {
        this.savingFile.set(false);
        this.toast.error(err?.error?.error || 'Save failed');
      },
    });
  }

  deleteFile() {
    const name = this.currentFileName();
    if (!name) return;
    if (!confirm(`Delete ${name}?`)) return;
    this.api.deleteTaskFile(this.slug(), this.taskId(), name).subscribe({
      next: () => {
        this.closeFile();
        this.toast.success('File deleted');
        this.loadFiles();
      },
      error: (err) => this.toast.error(err?.error?.error || 'Delete failed'),
    });
  }

  newFile() {
    const name = prompt('New filename (e.g. notes.md):');
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    this.api.writeTaskFile(this.slug(), this.taskId(), trimmed, '').subscribe({
      next: () => {
        this.toast.success(`Created ${trimmed}`);
        this.loadFiles();
        this.openFile(trimmed);
        this.fileMode.set('edit');
      },
      error: (err) => this.toast.error(err?.error?.error || 'Create failed'),
    });
  }

  loadDispatches() {
    this.dispatchesLoading.set(true);
    this.api.dispatches({ taskId: this.taskId(), limit: 50 }).subscribe({
      next: (d) => { this.dispatches.set(d); this.dispatchesLoading.set(false); },
      error: () => this.dispatchesLoading.set(false),
    });
  }

  taskEvents() {
    return this.sse.events().filter((e) =>
      e.data?.taskId === this.taskId() || e.data?.project === this.slug(),
    ).slice(0, 100);
  }

  filteredEvents() {
    const f = this.logFilter();
    const evts = this.taskEvents();
    if (f === 'all') return evts;
    if (f === 'invoker') return evts.filter((e) => e.type.startsWith('invoker.'));
    if (f === 'dispatch') return evts.filter((e) => e.type.startsWith('dispatch.'));
    if (f === 'agent') return evts.filter((e) => {
      if (e.type === 'session.message') return true;
      if (e.type === 'invoker.stdout' && typeof e.data?.chunk === 'string') {
        return e.data.chunk.includes('"agent.message"');
      }
      return false;
    });
    return evts;
  }

  formatTime(ts: number) {
    return new Date(ts).toLocaleTimeString();
  }

  jsonStringify(v: unknown) {
    try { return JSON.stringify(v); } catch { return String(v); }
  }

  prettyJson(s: string): string {
    try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
  }

  formatBytes(n: number) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  phaseBadge(phase: string) {
    return PHASE_BADGE[phase] ?? PHASE_BADGE['UNKNOWN'];
  }

  stateBadge(state: string) {
    switch (state) {
      case 'pending': return 'badge-ghost';
      case 'taken': return 'badge-accent';
      case 'done': return 'badge-success';
      case 'failed':
      case 'poisoned': return 'badge-error';
      default: return 'badge-ghost';
    }
  }

  fileLanguage(): string {
    return this.detectLanguage(this.currentFileName());
  }

  artifactLanguage(name: string): string {
    return this.detectLanguage(name);
  }

  private detectLanguage(name: string): string {
    const lower = name.toLowerCase();
    if (MD_EXTS.some((e) => lower.endsWith(e))) return 'markdown';
    if (JSON_EXTS.some((e) => lower.endsWith(e))) return 'json';
    if (YAML_EXTS.some((e) => lower.endsWith(e))) return 'yaml';
    if (lower.endsWith('.log') || lower.endsWith('.txt')) return 'text';
    return 'text';
  }

  fileIcon(name: string): string {
    const lang = this.detectLanguage(name);
    switch (lang) {
      case 'markdown': return '📝';
      case 'json': return '⌬';
      case 'yaml': return '⚙';
      default: return '📄';
    }
  }

  toggleArtifact(name: string) {
    const next = new Set(this.artifactCollapsed());
    if (next.has(name)) next.delete(name); else next.add(name);
    this.artifactCollapsed.set(next);
  }

  isArtifactCollapsed(name: string): boolean {
    return this.artifactCollapsed().has(name);
  }

  artifactMode(name: string): 'preview' | 'raw' {
    return this.artifactModes().get(name) ?? 'preview';
  }

  setArtifactMode(name: string, mode: 'preview' | 'raw') {
    const next = new Map(this.artifactModes());
    next.set(name, mode);
    this.artifactModes.set(next);
  }
}
