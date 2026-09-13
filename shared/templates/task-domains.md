# Task Domains in Orchestra

Task domains establish strict operational boundaries to prevent agents from wandering outside their assigned architectural area. Every implementation handoff must declare exactly one `taskDomain`.

## Default Core Domains

Orchestra provides standard domain enums suitable for any software project:

| Domain | Description | Typical Scope / Paths |
| :--- | :--- | :--- |
| `CODE` | Backend, core logic, business rules, algorithms | `src/core/**`, `src/lib/**`, `internal/**` |
| `UI` | Frontend components, layouts, styling, views | `src/components/**`, `src/ui/**`, `apps/web/**` |
| `DATA` | Schemas, database migrations, data models, parsing | `src/models/**`, `prisma/**`, `migrations/**` |
| `INFRA` | CI/CD, Docker, build configuration, scripts | `.github/**`, `scripts/**`, `Dockerfile` |
| `TESTING` | Test fixtures, test suites, benchmarks | `tests/**`, `cypress/**`, `__tests__/**` |
| `DOCS` | Documentation, user guides, specifications | `docs/**`, `*.md` |
| `RESEARCH` | Experiments, exploratory scripts, prototypes | `research/**`, `notebooks/**` |
| `ORCHESTRA` | Orchestra policies, agents, hooks, configurations | `.codex/**`, `.agents/**` |
| `GENERAL` | Root files, general repository management | Repository root, meta files |

## Customizing Domains for Your Project

You can extend or customize task domains for your project.

### In Codex:
In your project's `.codex/astra-orchestra/routing-policy.mjs`, you can define custom domains or pass custom domain sets to the routing helpers:
```javascript
import { TASK_DOMAINS, registerCustomDomains } from "./routing-policy.mjs";

registerCustomDomains([
  "MY_CUSTOM_ENGINE",
  "MY_AI_PIPELINE"
]);
```

### In Antigravity:
In your project's `.agents/skills/orchestra/routing-policy.mjs`, customize the domain taxonomy or define project-specific alias maps.

See `examples/autoeq-workbench/` for a real-world example of extending domains with `AUTOEQ_ALGORITHM` and `DSP_CORE`.
