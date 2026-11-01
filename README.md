# OpsDesk

Multi-tenant business operations SaaS (customers, pipeline, tasks, quotes) built as an engineering portfolio project. Production origin: `https://opsdesk.sitelaunch.dev` (not yet deployed).

## Setup

Requires Node 24 (see `.nvmrc`) and npm 11.

```bash
nvm use
npm ci
npm run dev        # http://localhost:3000
```

## Commands

| Command             | Purpose                      |
| ------------------- | ---------------------------- |
| `npm run dev`       | Start the dev server         |
| `npm run build`     | Production build             |
| `npm run start`     | Serve the production build   |
| `npm run lint`      | ESLint                       |
| `npm run typecheck` | `tsc --noEmit` (strict mode) |

More scripts, Supabase local setup, and the env table are added by later issues.
