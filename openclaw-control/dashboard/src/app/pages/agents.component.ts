import { Component, OnInit, inject, signal } from '@angular/core';
import { ApiService, Agent } from '../services/api.service';

@Component({
  selector: 'oc-agents',
  standalone: true,
  template: `
    <h1 style="margin:0 0 1rem">Agents</h1>
    <div class="muted" style="margin-bottom:1rem">
      Public bios live in the shared specs repo (everyone sees them).
      Personas + system prompts stay on each agent's owner machine and never sync.
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:1rem">
      @for (a of agents(); track a.id) {
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong style="color:var(--accent)">{{ a.name }}</strong>
            <span class="tag" [style.color]="statusColor(a.status)">{{ a.status }}</span>
          </div>
          <div class="muted" style="font-size:11px;margin-top:.25rem">{{ a.id }}</div>
          @if (a.persona) { <p class="muted" style="margin:.5rem 0 .25rem">{{ a.persona }}</p> }
          @if (a.capabilities?.length) {
            <div style="margin-top:.5rem;display:flex;gap:.25rem;flex-wrap:wrap">
              @for (c of a.capabilities; track c) { <span class="tag">{{ c }}</span> }
            </div>
          }
          <div style="margin-top:.75rem;display:flex;gap:.25rem;flex-wrap:wrap">
            <span class="tag" [style.color]="a.ownedHere ? 'var(--ok)' : 'var(--muted)'">
              {{ a.ownedHere ? '✓ owned here' : 'remote' }}
            </span>
            @if (a.busyWith) { <span class="tag phase-IN_PROGRESS">busy: {{ a.busyWith }}</span> }
          </div>
          @if (a.lastSeen) { <div class="muted" style="font-size:11px;margin-top:.5rem">last seen: {{ a.lastSeen }}</div> }
        </div>
      }
    </div>
    @if (agents().length === 0) {
      <div class="card">
        <p>No agents registered yet.</p>
        <p class="muted">
          Public bio: <span class="kbd">~/.claude/shared-specs/memory/agents/&lt;id&gt;/identity.md</span><br>
          Private persona (only on owner machine): <span class="kbd">~/.claude/local-memory/agents/&lt;id&gt;/persona.md</span>
        </p>
      </div>
    }
  `,
})
export class AgentsComponent implements OnInit {
  private api = inject(ApiService);
  agents = signal<Agent[]>([]);
  ngOnInit() { this.api.agents().subscribe((a) => this.agents.set(a)); }
  statusColor(s: string): string {
    if (s === 'online') return 'var(--ok)';
    if (s === 'busy') return 'var(--accent)';
    if (s === 'offline') return 'var(--err)';
    return 'var(--muted)';
  }
}
