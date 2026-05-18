import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ApiService, Agent, AgentActivity } from '../services/api.service';
import { SseService } from '../services/sse.service';
import { ToastService } from '../services/toast.service';
import { SkeletonComponent } from '../components/skeleton.component';

@Component({
  selector: 'oc-agents',
  standalone: true,
  imports: [SkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-4">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 class="text-2xl font-bold">Agents</h1>
        <div class="flex gap-2">
          <input
            type="text"
            placeholder="Filter agents..."
            class="input input-sm input-bordered w-full sm:w-56"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
        </div>
      </div>

      <p class="text-sm text-base-content/60">
        Public bios live in the shared specs repo. Personas + system prompts stay on each agent's owner machine and never sync.
      </p>

      @if (!loading()) {
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div class="stat bg-base-200 rounded-box p-3">
            <div class="stat-title text-xs">Online</div>
            <div class="stat-value text-lg text-success">{{ onlineCount() }}</div>
          </div>
          <div class="stat bg-base-200 rounded-box p-3">
            <div class="stat-title text-xs">Busy</div>
            <div class="stat-value text-lg text-accent">{{ busyCount() }}</div>
          </div>
          <div class="stat bg-base-200 rounded-box p-3">
            <div class="stat-title text-xs">Offline</div>
            <div class="stat-value text-lg text-error">{{ offlineCount() }}</div>
          </div>
          <div class="stat bg-base-200 rounded-box p-3">
            <div class="stat-title text-xs">Total</div>
            <div class="stat-value text-lg">{{ agents().length }}</div>
          </div>
        </div>
      }

      @if (loading()) {
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          @for (i of [1,2,3]; track i) {
            <div class="card bg-base-200 border border-base-300">
              <div class="card-body gap-3">
                <oc-skeleton cls="h-5 w-1/3" />
                <oc-skeleton cls="h-3 w-full" />
                <oc-skeleton cls="h-3 w-2/3" />
              </div>
            </div>
          }
        </div>
      } @else if (filtered().length === 0) {
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body">
            <p>No agents registered yet.</p>
            <p class="text-base-content/60 text-sm">
              Public bio: <kbd class="kbd kbd-sm">~/.claude/shared-specs/memory/agents/&lt;id&gt;/identity.md</kbd><br/>
              Private persona: <kbd class="kbd kbd-sm">~/.claude/local-memory/agents/&lt;id&gt;/persona.md</kbd>
            </p>
          </div>
        </div>
      } @else {
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          @for (a of filtered(); track a.id) {
            <div class="card bg-base-200 border border-base-300">
              <div class="card-body">
                <div class="flex items-center justify-between">
                  <span class="text-lg font-semibold text-primary">{{ a.name }}</span>
                  <span class="badge badge-sm" [class]="statusBadge(a.status)">{{ a.status }}</span>
                </div>
                <div class="text-xs text-base-content/50 font-mono">{{ a.id }}</div>

                @if (a.persona) {
                  <p class="text-sm text-base-content/70 mt-2 line-clamp-2">{{ a.persona }}</p>
                }

                @if (a.capabilities?.length) {
                  <div class="flex flex-wrap gap-1 mt-2">
                    @for (c of a.capabilities; track c) {
                      <span class="badge badge-outline badge-sm">{{ c }}</span>
                    }
                  </div>
                }

                @if (activityFor(a.id); as act) {
                  @if (act.lastTool) {
                    <div class="mt-3 rounded bg-base-300/60 p-2 space-y-1">
                      <div class="flex items-center gap-2 flex-wrap text-xs">
                        <span class="text-base-content/60">Now:</span>
                        <span class="badge badge-info badge-sm font-mono">{{ act.lastTool }}</span>
                        <span class="text-base-content/50">· {{ formatRelative(act.lastToolAt || act.lastEventTs) }}</span>
                      </div>
                      @if (toolBreakdown(act); as tb) {
                        <div class="flex flex-wrap gap-1">
                          @for (e of tb; track e.name) {
                            <span class="badge badge-ghost badge-xs font-mono">{{ e.name }}×{{ e.n }}</span>
                          }
                        </div>
                      }
                    </div>
                  } @else if (act.lastTextPreview) {
                    <p class="mt-3 text-xs italic text-base-content/60 line-clamp-2">
                      "{{ act.lastTextPreview }}"
                      <span class="text-base-content/40">· {{ formatRelative(act.lastEventTs) }}</span>
                    </p>
                  }
                }

                <div class="flex flex-wrap gap-2 mt-3">
                  @if (a.ownedHere) {
                    <span class="badge badge-success badge-sm">✓ owned here</span>
                  } @else {
                    <span class="badge badge-ghost badge-sm">remote</span>
                  }
                  @if (a.busyWith) {
                    <span class="badge badge-accent badge-sm">busy: {{ a.busyWith }}</span>
                  }
                </div>

                @if (a.lastSeen) {
                  <div class="text-xs text-base-content/50 mt-2">last seen: {{ a.lastSeen }}</div>
                }

                <div class="card-actions justify-end mt-3">
                  <button class="btn btn-sm btn-outline" [disabled]="syncing() === a.id" (click)="sync(a.id)">
                    @if (syncing() === a.id) {
                      <span class="loading loading-spinner loading-xs"></span>
                    }
                    Sync harness
                  </button>
                </div>
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class AgentsComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private sse = inject(SseService);
  private toast = inject(ToastService);

  agents = signal<Agent[]>([]);
  loading = signal(true);
  query = signal('');
  syncing = signal<string | null>(null);

  /** Activity summaries keyed by agentId. Populated on load + on SSE bumps. */
  private activity = signal<Map<string, AgentActivity>>(new Map());
  private lastSeenSessionEventTs = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Live refresh: every `session.message` SSE event bumps the activity
    // summary for the matching agent. Cheap because each request reads only
    // the tail of one JSONL.
    effect(() => {
      const events = this.sse.events();
      // Find the newest session.message we haven't acted on.
      const newest = events.find((e) => e.type === 'session.message');
      if (!newest || newest.ts <= this.lastSeenSessionEventTs) return;
      this.lastSeenSessionEventTs = newest.ts;
      const agentId = newest.data?.agentId;
      if (typeof agentId === 'string' && agentId.length > 0) {
        this.refreshActivity(agentId);
      }
    });
  }

  filtered = computed(() => {
    const q = this.query().toLowerCase().trim();
    if (!q) return this.agents();
    return this.agents().filter((a) =>
      a.id.toLowerCase().includes(q) ||
      a.name.toLowerCase().includes(q) ||
      a.capabilities?.some((c) => c.toLowerCase().includes(q))
    );
  });

  onlineCount = computed(() => this.agents().filter((a) => a.status === 'online').length);
  busyCount = computed(() => this.agents().filter((a) => a.status === 'busy').length);
  offlineCount = computed(() => this.agents().filter((a) => a.status === 'offline').length);

  activityFor(id: string): AgentActivity | undefined {
    return this.activity().get(id);
  }

  toolBreakdown(act: AgentActivity): Array<{ name: string; n: number }> {
    const entries = Object.entries(act.recentToolCounts ?? {});
    if (entries.length === 0) return [];
    return entries
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, n]) => ({ name, n }));
  }

  ngOnInit() {
    this.api.agents().subscribe({
      next: (a) => {
        this.agents.set(a);
        this.loading.set(false);
        // Kick off an activity fetch for every agent we know about.
        for (const ag of a) this.refreshActivity(ag.id);
      },
      error: () => this.loading.set(false),
    });
    // Slow-tick refresh as a backstop in case the SSE stream is delayed or
    // the page is left idle — every 60s, re-fetch activity for every known
    // agent. Cheap; the daemon endpoint only tails a few KB of JSONL.
    this.refreshTimer = setInterval(() => {
      for (const ag of this.agents()) this.refreshActivity(ag.id);
    }, 60_000);
  }

  ngOnDestroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  private refreshActivity(id: string): void {
    this.api.agentActivity(id).subscribe({
      next: (a) => {
        const next = new Map(this.activity());
        next.set(id, a);
        this.activity.set(next);
      },
      // Soft failure — keep the existing cache rather than blanking the row.
      error: () => {},
    });
  }

  statusBadge(status: string): string {
    switch (status) {
      case 'online': return 'badge-success';
      case 'busy': return 'badge-accent';
      case 'offline': return 'badge-error';
      default: return 'badge-ghost';
    }
  }

  formatRelative(iso: string | null | undefined): string {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return iso;
    const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return new Date(t).toLocaleString();
  }

  sync(id: string) {
    this.syncing.set(id);
    this.api.syncHarness(id).subscribe({
      next: (r) => {
        this.syncing.set(null);
        this.toast.success(`Harness synced for ${r.agentId}`);
      },
      error: (err) => {
        this.syncing.set(null);
        this.toast.error(err?.error?.error || 'Sync failed');
      },
    });
  }
}
