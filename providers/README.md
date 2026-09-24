# Provider extensions (model registry)

Drop a JSON file here to add NVIDIA-hosted models to the Model Router without editing
`config/models.json`. The schema is identical to `config/models.json`:

```json
{
  "models": [
    {
      "id": "nvidia/some-new-model",
      "provider": "nvidia",
      "endpoint": null,
      "enabled": true,
      "text": true,
      "vision": false,
      "tool_calling": false,
      "context_window": 131072,
      "max_output_tokens": 8192,
      "speed_tier": "standard",
      "quality_tier": 4,
      "preferred_tasks": ["reasoning", "planning"],
      "fallbacks": ["meta/llama-3.3-70b-instruct"]
    }
  ]
}
```

Rules enforced at load time (a file that breaks any rule is rejected as a whole and reported
in `GET /v1/extensions`):

- `provider` must be `nvidia`. Every call still goes through the key pool, the 55 RPM limiter
  and the Model Router.
- `endpoint` is `null` (use `NVIDIA_BASE_URL`) or an **https URL on an `nvidia.com` host**.
  The endpoint receives the API key, so a registry entry can never send a key anywhere else.
- Ids must be new (no overriding a base model) and every fallback must exist.
