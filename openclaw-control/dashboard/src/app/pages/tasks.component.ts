import { Component, OnInit, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ApiService, TaskSummary } from '../services/api.service';

const PHASES = ['CONTEXT','DESCRIPTION','PLAN','PENDING','IN_PROGRESS','IMPLEMENTED','QA_DONE','DONE'];

@Component({
  selector: 'oc-tasks',
  standalone: true,
  imports: [RouterLink, FormsModule],
  template: `
    <a routerLink="/projects" class="muted">← projects</a>
    <h1 style="margin:.5rem 0">{{ slug() }}</h1>

    <div class="card" style="margin-bottom:1rem">
      <strong>New task</strong>
      <div class="row" style="margin-top:.5rem">
        <input [(ngModel)]="newDesc" placeholder="describe a task — e.g. 'add health metrics endpoint'" />
        <input [(ngModel)]="newAgent" placeholder="agent (default: anubis)" style="max-width:160px" />
        <button class="primary" (click)="create()">Create</button>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat({{ phases.length }},minmax(180px,1fr));gap:.75rem;overflow-x:auto">
      @for (ph of phases; track ph) {
        <div>
          <h4 style="margin:.25rem 0;color:var(--muted);font-size:12px;text-transform:uppercase">{{ ph }}</h4>
          @for (t of byPhase(ph); track t.id) {
            <a [routerLink]="['/projects', slug(), 'tasks', t.id]" class="card" style="display:block;margin-bottom:.5rem;text-decoration:none;color:inherit">
              <div style="font-weight:600">{{ t.id }}</div>
              <div class="muted" style="font-size:11px">{{ t.title || '(no title)' }}</div>
              <div style="margin-top:.25rem;display:flex;gap:.25rem;flex-wrap:wrap">
                @if (t.assignedAgent) { <span class="tag">{{ t.assignedAgent }}</span> }
                @if (t.checkpointPending) { <span class="tag phase-PENDING">approval</span> }
              </div>
            </a>
          }
        </div>
      }
    </div>
  `,
})
export class TasksComponent implements OnInit {
  private api = inject(ApiService);
  slug = input.required<string>();
  tasks = signal<TaskSummary[]>([]);
  phases = PHASES;
  newDesc = '';
  newAgent = '';

  ngOnInit() { this.refresh(); }
  refresh() { this.api.tasks(this.slug()).subscribe((t) => this.tasks.set(t)); }
  byPhase(ph: string) { return this.tasks().filter((t) => t.phase === ph); }
  create() {
    if (!this.newDesc.trim()) return;
    this.api.createTask({
      project: this.slug(),
      description: this.newDesc.trim(),
      agentId: this.newAgent.trim() || undefined,
    }).subscribe(() => { this.newDesc = ''; this.refresh(); });
  }
}
