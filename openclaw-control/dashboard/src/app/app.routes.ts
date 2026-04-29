import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login.component').then(m => m.LoginComponent) },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/shell.component').then(m => m.ShellComponent),
    children: [
      { path: '', redirectTo: 'projects', pathMatch: 'full' },
      { path: 'projects', loadComponent: () => import('./pages/projects.component').then(m => m.ProjectsComponent) },
      { path: 'projects/:slug', loadComponent: () => import('./pages/tasks.component').then(m => m.TasksComponent) },
      { path: 'projects/:slug/tasks/:taskId', loadComponent: () => import('./pages/task-detail.component').then(m => m.TaskDetailComponent) },
      { path: 'agents', loadComponent: () => import('./pages/agents.component').then(m => m.AgentsComponent) },
      { path: 'sessions', loadComponent: () => import('./pages/sessions.component').then(m => m.SessionsComponent) },
      { path: 'memories', loadComponent: () => import('./pages/memories.component').then(m => m.MemoriesComponent) },
    ],
  },
  { path: '**', redirectTo: '' },
];
