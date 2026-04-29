import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface ProjectSummary {
  slug: string;
  path: string;
  taskCount: number;
  openTaskCount: number;
  checkpointCount: number;
}

export interface TaskSummary {
  id: string;
  project: string;
  phase: string;
  taskType?: string;
  title?: string;
  assignedAgent?: string;
  discordUserId?: string;
  channelId?: string;
  checkpointPending: boolean;
  updatedAt: string;
  folder: string;
}

export interface TaskDetail extends TaskSummary {
  artifacts: Record<string, string>;
}

export interface Agent {
  id: string;
  name: string;
  persona?: string;
  capabilities?: string[];
  ownerHint?: string;
  ownedHere: boolean;
  status: string;
  lastSeen?: string;
  busyWith?: string;
}

export interface MemoryEntry {
  scope: string;
  id: string;
  files: { name: string; size: number; mtime: string; private: boolean }[];
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  me(): Observable<{ discordId: string; username: string; avatar?: string }> {
    return this.http.get<any>('/api/auth/me', { withCredentials: true });
  }
  logout(): Observable<unknown> {
    return this.http.post('/api/auth/logout', {}, { withCredentials: true });
  }

  projects(): Observable<ProjectSummary[]> {
    return this.http.get<ProjectSummary[]>('/api/projects', { withCredentials: true });
  }
  tasks(slug: string): Observable<TaskSummary[]> {
    return this.http.get<TaskSummary[]>(`/api/projects/${slug}/tasks`, { withCredentials: true });
  }
  task(slug: string, taskId: string): Observable<TaskDetail> {
    return this.http.get<TaskDetail>(`/api/projects/${slug}/tasks/${taskId}`, { withCredentials: true });
  }
  createTask(body: { project: string; description: string; taskType?: string; agentId?: string }) {
    return this.http.post<{ taskId: string; folder: string }>('/api/tasks', body, { withCredentials: true });
  }
  approve(slug: string, taskId: string, body: { phase: string; decision: 'APPROVED' | 'REJECTED'; feedback?: string }) {
    return this.http.post(`/api/projects/${slug}/tasks/${taskId}/approve`, body, { withCredentials: true });
  }
  handoff(slug: string, taskId: string, toAgent: string, reason?: string) {
    return this.http.post(`/api/projects/${slug}/tasks/${taskId}/handoff`, { toAgent, reason }, { withCredentials: true });
  }
  tickContinuation() {
    return this.http.post<{ dispatched: number; pending: number; checkpoints: number }>('/api/continuation/tick', {}, { withCredentials: true });
  }

  agents(): Observable<Agent[]> {
    return this.http.get<Agent[]>('/api/agents', { withCredentials: true });
  }

  sessions(): Observable<any[]> {
    return this.http.get<any[]>('/api/sessions', { withCredentials: true });
  }
  latestSession(projectKey: string, lines = 100) {
    return this.http.get<any>(`/api/sessions/${projectKey}/latest?lines=${lines}`, { withCredentials: true });
  }

  memories(scope: string): Observable<MemoryEntry[]> {
    return this.http.get<MemoryEntry[]>(`/api/memories/${scope}`, { withCredentials: true });
  }
  readMemory(scope: string, id: string, file: string) {
    return this.http.get<{ content: string; private: boolean }>(`/api/memories/${scope}/${id}/${file}`, { withCredentials: true });
  }
  writeMemory(scope: string, id: string, file: string, content: string) {
    return this.http.put(`/api/memories/${scope}/${id}/${file}`, { content }, { withCredentials: true });
  }
  deleteMemory(scope: string, id: string, file: string) {
    return this.http.delete(`/api/memories/${scope}/${id}/${file}`, { withCredentials: true });
  }
}
