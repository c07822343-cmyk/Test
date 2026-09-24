# QA check extensions

Each JSON file adds deterministic checklist items to the project scorecard. They run against
the final site files next to the built-in criteria and report passed / failed / not evaluated
with evidence — they are checks, not opinions.

```json
{
  "checks": [
    {
      "id": "QA-TEL-LINKS",
      "category": "functionality",
      "criterion": "Phone numbers are clickable on mobile",
      "type": "regex_present",
      "value": "href=\"tel:",
      "files": "*.html",
      "scope": "any"
    }
  ]
}
```

- `id`: must start with `QA-` (uppercase letters, digits, dashes).
- `category`: one of the scorecard categories (`functionality`, `visual_quality`, `ux`,
  `responsiveness`, `accessibility`, `seo`, `performance`, `content_completeness`,
  `technical_quality`, `project_requirements`).
- `type`: `text_present`, `text_absent` (tag-stripped page text for HTML), `regex_present`,
  `regex_absent` (raw file), `element_present` (tag name), `file_exists` (`value` is a path).
- `files`: a file name or suffix pattern (`*.html`, `*.css`); `scope`: `every` file or `any`.

Invalid ids, categories or regular expressions are rejected at boot and listed in
`GET /v1/extensions`.
