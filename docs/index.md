---
layout: home

hero:
  name: "hive-claw"
  text: "Multi-machine, multi-agent AI control plane"
  tagline: Run a fleet of AI agents — each on its own machine, sharing one task tree, coordinating over Discord.
  actions:
    - theme: brand
      text: Quick Start
      link: /SETUP
    - theme: alt
      text: Control Plane
      link: /OPENCLAW_CONTROL
    - theme: alt
      text: GitHub
      link: https://github.com/Hive-Academy/hive-claw

features:
  - icon: 🤖
    title: Multi-agent, multi-machine
    details: Each physical machine runs the same Docker image. One is the leader; the rest are followers. Each owns one or more named agents with independent personas.
  - icon: 🔒
    title: Persona privacy, by design
    details: Agent personas live in local-memory/ — never synced, never served over HTTP. Defense-in-depth across four enforcement layers.
  - icon: ⚡
    title: Atomic dispatch queue
    details: Task phases dispatch to whichever machine owns the assigned agent. Claim = git push with rebase. No shared filesystem, no race conditions.
  - icon: 🎮
    title: Discord-native interface
    details: One bot per agent, routing @mentions through the configured LLM provider. Tool calls, subagents, and MCP clients all wired in.
  - icon: 📊
    title: Angular dashboard
    details: Projects → tasks → kanban → approve / reject / handoff. Live agent status. Memory editor. Served by the Fastify daemon on :7878.
  - icon: 🐳
    title: Single Docker image
    details: Gateway tier (openclaw on :18789) and control plane (daemon on :7878) ship in the same container. Compose up and you're running.
---
