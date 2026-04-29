import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, MemoryEntry } from '../services/api.service';

const SCOPES = ['agents', 'users', 'projects', 'threads'] as const;

@Component({
  selector: 'oc-memories',
  standalone: true,
  imports: [FormsModule],
  template: `
    <h1 style="margin:0 0 1rem">Memories</h1>
    <div class="muted" style="margin-bottom:1rem">
      Shared memory tree under <span class="kbd">~/.claude/shared-memory/</span>.
    </div>
    <div style="display:grid;grid-template-columns:200px 280px 1fr;gap:1rem">
      <div class="card">
        <strong>Scope</strong>
        @for (s of scopes; track s) {
          <div>
            <button (click)="selectScope(s)" [class.primary]="scope() === s" style="margin-top:.25rem;width:100%">{{ s }}</button>
          </div>
        }
      </div>
      <div class="card">
        <strong>{{ scope() }}</strong>
        <div style="margin-top:.5rem" class="col">
          <input [(ngModel)]="newId" placeholder="new id (e.g. discord-user-id)" />
          <input [(ngModel)]="newFile" placeholder="filename (profile.md)" />
          <button (click)="newEntry()">New</button>
        </div>
        <hr style="border-color:var(--border);margin:.75rem 0" />
        @for (e of entries(); track e.id) {
          <div style="margin-bottom:.5rem">
            <div style="font-weight:600">{{ e.id }}</div>
            @for (f of e.files; track f.name) {
              <button (click)="open(e.id, f.name)" style="display:block;width:100%;text-align:left;margin-top:2px;padding:.2rem .4rem">
                {{ f.name }}
                @if (f.private) { <span class="tag" style="color:var(--accent);margin-left:.25rem">private</span> }
                <span class="muted">{{ f.size }}b</span>
              </button>
            }
          </div>
        }
      </div>
      <div class="card">
        @if (currentFile()) {
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>
              {{ scope() }}/{{ currentId() }}/{{ currentFile() }}
              @if (currentPrivate()) { <span class="tag" style="color:var(--accent);margin-left:.5rem">private (this machine only)</span> }
            </strong>
            <div class="row">
              <button (click)="save()" class="primary">Save</button>
              <button (click)="del()" class="danger">Delete</button>
            </div>
          </div>
          @if (currentPrivate()) {
            <p class="muted" style="margin:.5rem 0 0">This file lives in <span class="kbd">~/.claude/local-memory/</span> on this machine only — never committed to the shared specs repo.</p>
          }
          <textarea [(ngModel)]="content" style="margin-top:.5rem;min-height:480px"></textarea>
        } @else {
          <p class="muted">Pick a file on the left to view or edit its content.</p>
        }
      </div>
    </div>
  `,
})
export class MemoriesComponent implements OnInit {
  private api = inject(ApiService);
  scopes = SCOPES;
  scope = signal<string>('users');
  entries = signal<MemoryEntry[]>([]);
  currentId = signal<string>('');
  currentFile = signal<string>('');
  currentPrivate = signal<boolean>(false);
  content = '';
  newId = '';
  newFile = '';

  ngOnInit() { this.refresh(); }
  selectScope(s: string) { this.scope.set(s); this.refresh(); }
  refresh() { this.api.memories(this.scope()).subscribe((e) => this.entries.set(e)); }
  open(id: string, file: string) {
    this.currentId.set(id);
    this.currentFile.set(file);
    this.api.readMemory(this.scope(), id, file).subscribe((r) => {
      this.content = r.content;
      this.currentPrivate.set(r.private);
    });
  }
  save() {
    if (!this.currentId() || !this.currentFile()) return;
    this.api.writeMemory(this.scope(), this.currentId(), this.currentFile(), this.content).subscribe(() => this.refresh());
  }
  del() {
    if (!this.currentId() || !this.currentFile()) return;
    this.api.deleteMemory(this.scope(), this.currentId(), this.currentFile()).subscribe(() => {
      this.currentFile.set(''); this.content = ''; this.refresh();
    });
  }
  newEntry() {
    if (!this.newId.trim() || !this.newFile.trim()) return;
    this.api.writeMemory(this.scope(), this.newId.trim(), this.newFile.trim(), '').subscribe(() => {
      this.currentId.set(this.newId.trim());
      this.currentFile.set(this.newFile.trim());
      this.newId = ''; this.newFile = ''; this.content = '';
      this.refresh();
    });
  }
}
