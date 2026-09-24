# Memory seeds (global knowledge base)

JSON files here seed the **global** knowledge base at boot: reusable, non-project-specific
lessons that the Context Builder retrieves by tag for relevant agents.

```json
[
  {
    "id": "kb_example",
    "category": "design_principles",
    "title": "Short, reusable lesson",
    "content": "One or two sentences an agent can act on.",
    "tags": ["frontend_developer", "premium-design"]
  }
]
```

- `category` is one of: design_principles, coding_patterns, successful_patterns, common_bugs,
  client_requirements, seo_rules, accessibility_rules, apexweb_preferences, approved_libraries,
  project_structure, performance, qa_findings, process.
- Existing ids are never overwritten, so edits made by operators through the API survive restarts.
- Project, task and agent memory live in Postgres (`memory` table), not here.
- Lessons learned during projects are **not** written here automatically. Retrospectives
  create *candidate* entries that stay inactive until a human promotes them
  (`/promote <id>` or `POST /v1/knowledge/:id/approve`), and entries that mention
  project-specific details (client names, locations, placeholders) are refused.
