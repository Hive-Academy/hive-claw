import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'hive-claw',
  description: 'Multi-machine, multi-agent AI control plane — openclaw + ptah-cli',
  base: '/hive-claw/',

  head: [
    ['link', { rel: 'icon', href: '/hive-claw/favicon.ico' }],
  ],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/SETUP' },
      { text: 'Follower Setup', link: '/FOLLOWER_SETUP' },
      { text: 'Architecture', link: '/ARCHITECTURE' },
      { text: 'Configuration', link: '/CONFIGURATION' },
      { text: 'Playbooks', link: '/PLAYBOOKS' },
      { text: 'GitHub', link: 'https://github.com/Hive-Academy/hive-claw' },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Home', link: '/' },
          { text: 'Setup', link: '/SETUP' },
          { text: 'Follower Setup', link: '/FOLLOWER_SETUP' },
          { text: 'Control Plane', link: '/OPENCLAW_CONTROL' },
          { text: 'Playbooks', link: '/PLAYBOOKS' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Architecture', link: '/ARCHITECTURE' },
          { text: 'Configuration', link: '/CONFIGURATION' },
          { text: 'Skills & Persona', link: '/SKILLS-AND-PERSONA' },
          { text: 'Operations', link: '/OPERATIONS' },
        ],
      },
      {
        text: 'Security & Reliability',
        items: [
          { text: 'Security', link: '/SECURITY' },
          { text: 'Troubleshooting', link: '/TROUBLESHOOTING' },
          { text: 'Cutover Runbook', link: '/CUTOVER_RUNBOOK' },
        ],
      },
      {
        text: 'Integrations',
        items: [
          { text: 'ptah-cli Handoff', link: '/HANDOFF-ptah-cli' },
        ],
      },
      {
        text: 'Archive',
        collapsed: true,
        items: [
          { text: 'Vision (pre-impl)', link: '/archive/vision' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/Hive-Academy/hive-claw' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-present Hive Academy',
    },

    editLink: {
      pattern: 'https://github.com/Hive-Academy/hive-claw/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    search: {
      provider: 'local',
    },

    lastUpdated: {
      text: 'Updated at',
      formatOptions: {
        dateStyle: 'full',
        timeStyle: 'medium',
      },
    },
  },

  markdown: {
    lineNumbers: true,
  },
})
