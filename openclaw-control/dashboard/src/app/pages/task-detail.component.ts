import { Component, OnInit, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ApiService, TaskDetail } from '../services/api.service';
import { SseService } from '../services/sse.service';

@Component({
  selector: 'oc-task-detail',
  standalone: true,
  imports: [RouterLink, FormsModule],
  template: `
    <a [routerLink]="['/projects', slug()]" class="muted">← {{ slug() }}</a>
    @if (task(); as t) {
      <h1 style="margin:.5rem 0">{{ t.id }}</h1>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1rem">
        <span class="tag" [class]="'tag phase-' + t.phase">{{ t.phase }}</span>
        @if (t.assignedAgent) { <span class="tag">agent: {{ t.assignedAgent }}</span> }
        @if (t.discordUserId) { <span class="tag">user: {{ t.discordUserId }}</span> }
        @if (t.taskType) { <span class="tag">{{ t.taskType }}</span> }
      </div>

      @if (t.checkpointPending) {
        <div class="checkpoint-banner">
          <strong>USER VALIDATION CHECKPOINT — phase {{ t.phase }}</strong>
          <p class="muted" style="margin:.25rem 0">Approve to let the continuation loop run the next phase.</p>
          <textarea [(ngModel)]="feedback" placeholder="optional feedback / revision notes" style="min-height:80px"></textarea>
          <div class="row" style="margin-top:.5rem">
            <button class="primary" (click)="approve(t.phase)">APPROVE</button>
            <button class="danger" (click)="reject(t.phase)">REJECT</button>
            <button (click)="tickNow()">Tick continuation loop</button>
          </div>
        </div>
      }

      <div class="row" style="margin-bottom:1rem">
        <button (click)="refresh()">Refresh</button>
        <input [(ngModel)]="handoffTo" placeholder="handoff to agent…" style="max-width:200px" />
        <button (click)="handoff()">Handoff</button>
      </div>

      @for (entry of artifactList(t.artifacts); track entry.name) {
        <details class="card" [open]="entry.name === 'tasks.md'" style="margin-bottom:.75rem">
          <summary style="cursor:pointer;font-weight:600">{{ entry.name }}</summary>
          <pre>{{ entry.content }}</pre>
        </details>
      }
    } @else {
      <p>loading…</p>
    }
  `,
})
export class TaskDetailComponent implements OnInit {
  private api = inject(ApiService);
  private sse = inject(SseService);
  slug = input.required<string>();
  taskId = input.required<string>();
  task = signal<TaskDetail | null>(null);
  feedback = '';
  handoffTo = '';

  ngOnInit() {
    this.refresh();
    setInterval(() => {
      const evts = this.sse.events();
      if (evts.some((e) => e.data?.taskId === this.taskId())) this.refresh();
    }, 3000);
  }
  refresh() { this.api.task(this.slug(), this.taskId()).subscribe((t) => this.task.set(t)); }
  approve(phase: string) {
    this.api.approve(this.slug(), this.taskId(), { phase, decision: 'APPROVED', feedback: this.feedback })
      .subscribe(() => { this.feedback = ''; this.refresh(); });
  }
  reject(phase: string) {
    this.api.approve(this.slug(), this.taskId(), { phase, decision: 'REJECTED', feedback: this.feedback })
      .subscribe(() => { this.feedback = ''; this.refresh(); });
  }
  handoff() {
    if (!this.handoffTo.trim()) return;
    this.api.handoff(this.slug(), this.taskId(), this.handoffTo.trim())
      .subscribe(() => { this.handoffTo = ''; this.refresh(); });
  }
  tickNow() { this.api.tickContinuation().subscribe(() => this.refresh()); }
  artifactList(a: Record<string, string>) {
    return Object.entries(a).map(([name, content]) => ({ name, content }));
  }
}
