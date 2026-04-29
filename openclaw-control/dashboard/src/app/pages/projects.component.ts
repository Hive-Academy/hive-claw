import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService, ProjectSummary } from '../services/api.service';

@Component({
  selector: 'oc-projects',
  standalone: true,
  imports: [RouterLink],
  template: `
    <h1 style="margin:0 0 1rem">Projects</h1>
    <div class="muted" style="margin-bottom:1rem">
      Projects with a <span class="kbd">.ptah/specs/</span> directory under the configured roots.
    </div>
    @if (loading()) { <p>loading…</p> }
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:1rem">
      @for (p of projects(); track p.slug) {
        <a class="card" [routerLink]="['/projects', p.slug]" style="text-decoration:none;color:inherit;display:block">
          <div style="display:flex;justify-content:space-between;align-items:start">
            <strong style="color:var(--accent)">{{ p.slug }}</strong>
            @if (p.checkpointCount > 0) {
              <span class="tag phase-PENDING">{{ p.checkpointCount }} checkpoint(s)</span>
            }
          </div>
          <div class="muted" style="font-size:11px;margin:.25rem 0;word-break:break-all">{{ p.path }}</div>
          <div class="muted">{{ p.openTaskCount }} open / {{ p.taskCount }} total</div>
        </a>
      }
    </div>
    @if (!loading() && projects().length === 0) {
      <div class="card">
        <p>No projects with <span class="kbd">.ptah/specs/</span> found.</p>
        <p class="muted">Set <span class="kbd">OPENCLAW_PROJECT_ROOTS</span> to colon-separated dirs to scan.</p>
      </div>
    }
  `,
})
export class ProjectsComponent implements OnInit {
  private api = inject(ApiService);
  projects = signal<ProjectSummary[]>([]);
  loading = signal(true);
  ngOnInit() {
    this.api.projects().subscribe({
      next: (p) => { this.projects.set(p); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }
}
