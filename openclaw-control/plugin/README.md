# @openclaw-control/plugin

OpenClaw native plugin for the openclaw-control fleet. At maturity it exposes
`invoke_ptah` plus a set of daemon-CRUD tools (`list_projects`, `list_tasks`,
`get_task`, `create_task`, `approve_task`, `handoff_task`) and install-request
helpers, all proxied through the daemon at `:7878`. This package is currently
a Batch 2 skeleton — `npm install && npm run build` produces `dist/index.js`
and the plugin loads as a no-op until later batches register the tools.
