# @pipeworx/hibp

Have I Been Pwned MCP — breach history + pwned passwords.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

Free (no key):
- `check_password(password)` — k-anonymity check; password never leaves the worker.
- `check_password_prefix(sha1_prefix)` — k-anonymity by SHA-1 prefix.
- `list_breaches(domain?)` — all breaches.
- `get_breach(name)` — single breach.
- `list_data_classes()` — canonical data-class tags.

Paid (BYO key):
- `check_account(account, truncate?)` — breaches an email appears in. Requires a paid HIBP subscription key (https://haveibeenpwned.com/API/Key).

## Data sources

- `https://api.pwnedpasswords.com/range/{prefix}` — no auth
- `https://haveibeenpwned.com/api/v3/` — `hibp-api-key` header for account lookups

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "hibp": {
      "url": "https://gateway.pipeworx.io/hibp/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Hibp data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
