# Agent extensions

Drop a JSON file here to register a new specialist without changing orchestration code.
It is validated at boot (type, mission, instructions, result shape, pipeline, capability,
tool profile and tools against the permission model) and becomes available to the planner,
the dispatcher, the skills engine and n8n routing.

```json
{
  "type": "email_marketing_specialist",
  "name": "Email Marketing Specialist",
  "department": "content",
  "pipeline": "content",
  "capability": "copywriting",
  "mission": "Write lifecycle email sequences that match the website voice.",
  "instructions": ["One goal per email.", "No invented offers or statistics."],
  "resultShape": "{\"emails\":[{\"subject\":string,\"body\":string}]}",
  "toolProfile": "content",
  "maxTokens": 4096
}
```
