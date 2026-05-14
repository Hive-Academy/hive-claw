import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  Agent,
  AgentActivity,
  Dispatch,
  DispatchState,
  HealthStatus,
  MemoryEntry,
  ProjectSummary,
  SessionInfo,
  SessionTail,
  TaskAdvanceResult,
  TaskDetail,
  TaskFileBody,
  TaskFileMeta,
  TaskSummary,
} from '../models/index';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  me(): Observable<{ discordId: string; username: string; avatar?: string }> {
    return this.http.get<any>('/api/auth/me', { withCredentials: true });
  }

  logout(): Observable<unknown> {
    return this.http.post('/api/auth/logout', {}, { withCredentials: true });
  }

  health(): Observable<HealthStatus> {
    return this.http.get<HealthStatus>('/api/health', { withCredentials: true });
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

  // TASK_2026_004 (HITL refactor): the bulk tick endpoint was removed.
  // Use `advanceTask` to dispatch one explicit phase at a time.

  advanceTask(slug: string, taskId: string): Observable<TaskAdvanceResult> {
    return this.http.post<TaskAdvanceResult>(
      `/api/projects/${slug}/tasks/${taskId}/advance`,
      {},
      { withCredentials: true },
    );
  }

  cancelPendingForTask(slug: string, taskId: string): Observable<{ ok: true; cancelled: number }> {
    return this.http.post<{ ok: true; cancelled: number }>(
      `/api/projects/${slug}/tasks/${taskId}/cancel-pending`,
      {},
      { withCredentials: true },
    );
  }

  acknowledgeNoProgress(slug: string, taskId: string): Observable<{ ok: true; dispatchBudget: number }> {
    return this.http.post<{ ok: true; dispatchBudget: number }>(
      `/api/projects/${slug}/tasks/${taskId}/acknowledge-no-progress`,
      {},
      { withCredentials: true },
    );
  }

  topUpBudget(slug: string, taskId: string, opts: { delta?: number; set?: number }): Observable<{ ok: true; dispatchBudget: number }> {
    return this.http.post<{ ok: true; dispatchBudget: number }>(
      `/api/projects/${slug}/tasks/${taskId}/budget`,
      opts,
      { withCredentials: true },
    );
  }

  cancelDispatch(id: string): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`/api/dispatches/${id}`, { withCredentials: true });
  }

  taskFiles(slug: string, taskId: string): Observable<TaskFileMeta[]> {
    return this.http.get<TaskFileMeta[]>(`/api/projects/${slug}/tasks/${taskId}/files`, { withCredentials: true });
  }

  readTaskFile(slug: string, taskId: string, filename: string): Observable<TaskFileBody> {
    return this.http.get<TaskFileBody>(`/api/projects/${slug}/tasks/${taskId}/files/${filename}`, { withCredentials: true });
  }

  writeTaskFile(slug: string, taskId: string, filename: string, content: string): Observable<{ ok: true; sizeBytes: number }> {
    return this.http.put<{ ok: true; sizeBytes: number }>(`/api/projects/${slug}/tasks/${taskId}/files/${filename}`, { content }, { withCredentials: true });
  }

  deleteTaskFile(slug: string, taskId: string, filename: string): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`/api/projects/${slug}/tasks/${taskId}/files/${filename}`, { withCredentials: true });
  }

  dispatches(filters?: { state?: DispatchState; projectSlug?: string; taskId?: string; limit?: number }): Observable<Dispatch[]> {
    let params = new HttpParams();
    if (filters?.state) params = params.set('state', filters.state);
    if (filters?.projectSlug) params = params.set('projectSlug', filters.projectSlug);
    if (filters?.taskId) params = params.set('taskId', filters.taskId);
    if (filters?.limit) params = params.set('limit', String(filters.limit));
    return this.http.get<Dispatch[]>('/api/dispatches', { params, withCredentials: true });
  }

  dispatch(id: string): Observable<Dispatch> {
    return this.http.get<Dispatch>(`/api/dispatches/${id}`, { withCredentials: true });
  }

  agents(): Observable<Agent[]> {
    return this.http.get<Agent[]>('/api/agents', { withCredentials: true });
  }

  syncHarness(id: string): Observable<{ ok: boolean; agentId: string; harnessHash: string }> {
    return this.http.post<{ ok: boolean; agentId: string; harnessHash: string }>(`/api/agents/${id}/harness/sync`, {}, { withCredentials: true });
  }

  sessions(): Observable<SessionInfo[]> {
    return this.http.get<SessionInfo[]>('/api/sessions', { withCredentials: true });
  }

  tailSession(agentId: string, lines = 100): Observable<SessionTail> {
    return this.http.get<SessionTail>(`/api/sessions/${agentId}/latest?lines=${lines}`, { withCredentials: true });
  }

  agentActivity(id: string): Observable<AgentActivity> {
    return this.http.get<AgentActivity>(`/api/agents/${id}/activity`, { withCredentials: true });
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

export type {
  Agent,
  AgentActivity,
  Dispatch,
  DispatchState,
  HealthStatus,
  MemoryEntry,
  ProjectSummary,
  SessionInfo,
  SessionTail,
  TaskAdvanceResult,
  TaskDetail,
  TaskFileBody,
  TaskFileMeta,
  TaskSummary,
} from '../models/index';
