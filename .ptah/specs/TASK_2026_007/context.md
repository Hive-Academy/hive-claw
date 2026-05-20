# TASK_2026_007 — Dashboard UX Overhaul + Full CRUD

## User Request
Dashboard needs a major UX overhaul:
1. Sessions/messages shown as raw JSON — should be a chat-style interface
2. Projects page has no Create/Delete UI, misleading hint about OPENCLAW_PROJECT_ROOTS
3. Tasks have no delete or agent-reassignment from the dashboard
4. Markdown rendering is plain, not beautiful
5. Agents should be able to make all CRUD operations on projects and tasks

## Task Type
FEATURE

## Workflow
Full: PM → Architect → Team-Leader → QA

## CLI Delegation
disabled

## Key Files (identified at task creation)
### Backend
- openclaw-control/daemon/src/api.ts — Fastify routes (missing DELETE /api/projects/:slug, PUT /api/projects/:slug, DELETE on tasks)
- openclaw-control/daemon/src/projects.ts — discoverProjects, getProject
- openclaw-control/daemon/src/storage.ts — storage facade
- openclaw-control/daemon/src/db/projects.ts — ProjectsRepo

### Frontend (Angular)
- openclaw-control/dashboard/src/app/pages/sessions.component.ts — raw JSON dump, needs chat UI
- openclaw-control/dashboard/src/app/pages/projects.component.ts — read-only list, needs Create/Delete + fix hint
- openclaw-control/dashboard/src/app/pages/tasks.component.ts — needs delete + reassign
- openclaw-control/dashboard/src/app/pages/task-detail.component.ts — task detail
- openclaw-control/dashboard/src/app/components/markdown.component.ts — needs rich rendering
- openclaw-control/dashboard/src/app/services/api.service.ts — add createProject, deleteProject, deleteTask, updateTask methods

## Created
2026-05-20
