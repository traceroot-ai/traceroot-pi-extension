# @traceroot-ai/pi-extension

TraceRoot extension for [pi](https://github.com/earendil-works/pi-coding-agent) that sends per-session traces to [TraceRoot](https://traceroot.ai).

Each pi session is traced with conversation turns, LLM calls, tool executions, token usage, and session continuity metadata.

---

## Installation

Install from npm:

```bash
pi install npm:@traceroot-ai/pi-extension
```

Or, from a clone of this repo:

```bash
pi install .
```

---

## Configuration

Tracing is opt-in. Set the following environment variables before starting pi:

| Variable                  | Required | Description                                                                                                |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `TRACEROOT_ENABLED`       | Yes      | Set to `true` to enable tracing.                                                                           |
| `TRACEROOT_API_KEY`       | Yes      | Your TraceRoot API key. Find it at [app.traceroot.ai](https://app.traceroot.ai) under Settings > API Keys. |
| `TRACEROOT_HOST_URL`      | No       | TraceRoot base URL. Defaults to the hosted service. Set this only when self-hosting.                       |
| `TRACEROOT_OTLP_ENDPOINT` | No       | Explicit OTLP traces endpoint override. Defaults to `<TRACEROOT_HOST_URL>/api/v1/public/traces`.           |

Example (add to `~/.zshrc`, `~/.bashrc`, or your shell profile):

```bash
export TRACEROOT_ENABLED=true
export TRACEROOT_API_KEY="tr-..."
# Optional: only needed for self-hosted deployments
# export TRACEROOT_HOST_URL="https://your-traceroot.example.com"
```

Restart pi, or open a new terminal session, after setting the variables.

---

## Local development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```

## License

Apache-2.0
