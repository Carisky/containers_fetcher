# API key authentication

Set `API_KEY` (single value) or `API_KEYS` (comma-separated list) before starting the server. When nothing is provided a fallback key `dev-local-key` is used. The header name can be changed with `API_KEY_HEADER` (defaults to `x-api-key`).

Every call to `/lookup` and `/lookup-bct` must include the key. Example for the Excel script:

```ts
resp = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": "<YOUR_SECRET_KEY>",
  },
  body: JSON.stringify({ containers, t_status: true }),
});
```

You can also send the token as `Authorization: Bearer <YOUR_SECRET_KEY>` if the client cannot set custom headers.
