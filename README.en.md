# pi-auth-bridge (dsh-pi-auth-bridge)

> [中文](./README.md) | **English**

Converts the local **pi** (pi-mono / Pi coding agent) auth configuration (`auth.json` + `models.json`) into dsh LLM routes **in memory** — ready to use the moment it loads, never persisted. Think of it as an auth adapter bridge: every provider you have logged into in pi is directly usable in dsh.

- **Zero config**: reads `$PI_CODING_AGENT_DIR` by default, falling back to `~/.pi/agent` (`%USERPROFILE%\.pi\agent` on Windows).
- **Read-only, memory-only**: credentials live only in process memory — never written to the dsh credential store, never written back to `~/.pi`, never written to any temp file.
- **Never breaks the composition**: missing pi directory, corrupt config, or no usable credentials result in an empty mount with a warning, never an exception.

## Installation

### Git versioned install (recommended, no clone)

`dsh plugin add` is essentially a pnpm forwarder, so you can install a specific version straight from a git tag:

```bash
# Pin a version tag (recommended, reproducible)
dsh plugin --profile <name> add git+https://github.com/xnightsky/dsh-pi-auth-bridge.git#v0.1.0

# or track the latest master
dsh plugin --profile <name> add git+https://github.com/xnightsky/dsh-pi-auth-bridge.git
```

Git installs build `dist/` via the package's `prepare` script. pnpm blocks dependency build scripts by default: if the first install is blocked, add the key dsh prints to `allowBuilds` in the profile's `pnpm-workspace.yaml`, then re-run the same command.

### Local install (development)

```bash
git clone https://github.com/xnightsky/dsh-pi-auth-bridge.git
cd dsh-pi-auth-bridge
npm install
npm run build   # produces dist/ (ESM + .d.ts)
dsh plugin --profile <name> add /abs/path/dsh-pi-auth-bridge
```

Dependencies: `@earendil-works/pi-ai` (runtime); `@deepseek-ai/cordis` and `@deepseek-ai/dsh-llm` (peers, provided by the dsh composition).

> Node version: pi-ai 0.84.x declares `node >= 22.19`. Every feature of this plugin has been verified on Node 20 (only an EBADENGINE warning at install time), but Node 22+ is recommended to stay in line with dsh.

## Usage in dsh

### As a dsh bundle (official way)

This package follows the official dsh plugin convention: the entry point exports `name` / `inject: ['llm']` / `Config` / `apply`, and `package.json` declares `dsh.bundle.patch` pointing at the root `cordis.patch.yml` (zero-config mount by default, id `pi-auth-bridge`). Add it to a profile:

```bash
dsh plugin --profile <name> add /abs/path/dsh-pi-auth-bridge   # local path or git URL (see Installation above)
```

To override the config, use the same id in the profile-level `cordis.patch.yml`:

```yaml
- insert:
    - id: pi-auth-bridge
      name: dsh-pi-auth-bridge
      config:
        # piDir: /custom/pi/agent        # override the pi config directory
        # providers: [anthropic, openai] # bridge only whitelisted providers
        includeOAuth: true                # whether to bridge OAuth credentials
        commandTimeoutMs: 10000           # timeout for !cmd value commands
```

### Direct absolute-path mount (development)

Bypass the bundle mechanism and `insert` directly in any cordis config layer; both entry points work:

```yaml
# Load the TypeScript source directly (dsh can load a TS plugin entry by absolute path)
- insert: [{ id: pi-auth-bridge, name: '/abs/path/pi-auth-bridge/src/index.ts' }]

# or load the build output
- insert: [{ id: pi-auth-bridge, name: '/abs/path/pi-auth-bridge/dist/index.js' }]
```

Once mounted, route names carry the fixed `pi/<providerId>` prefix (e.g. `pi/openai`), and group titles are always crowned with `Pi · ` (e.g. `Pi · OpenAI`) — the dsh web model picker has only two levels ("group → model"), so PI cannot be a true third-level channel; its origin is expressed jointly by the route prefix and the group title, plainly distinguishable from dsh-native providers. The model catalog comes from the pi-ai built-in catalog or custom declarations in `models.json`.

## How it works

```
locatePiDir → readPiAuth/readPiModels → buildRoutes → PiAuthBridgeAdapter → ctx.llm.registerAdapter
```

1. **Locate** (`pi-locator.ts`): explicit `piDir` > `$PI_CODING_AGENT_DIR` > `homedir()/.pi/agent`; the directory must contain at least one of `auth.json` / `models.json`.
2. **Read** (`pi-auth.ts`): missing file → `undefined`; corrupt JSON → `PiAuthBridgeError` with the path (caught at the plugin layer → empty mount + warn); a single invalid entry → skipped + warn.
3. **Convert** (`convert.ts`, pure function):
   - a provider with credentials in `auth.json` → a builtin route (provider metadata delegated to the pi-ai built-in catalog);
   - a custom provider in `models.json` → full-field mapping of `{ api, baseURL, models, headers, authHeader }`;
   - apiKey priority: same-named `auth.json` entry > the `apiKey` field of `models.json`;
   - value resolution matches pi itself: `"$ENV_VAR"` reads an environment variable, `"!cmd args"` runs a shell command and takes its stdout (10s default timeout, in-memory cache, at most one execution per mount), anything else is a literal.
4. **Adapt** (`provider.ts` / `request.ts` / `stream.ts` / `adapter.ts`): `PiAuthBridgeAdapter extends LlmAdapter`, builds the pi-ai collection with `createModels`, and passes credentials via a per-request `apiKey` override (routes with `authHeader: true` send the key as an `Authorization: Bearer <key>` header instead); honors the dsh adapter contract (`usage` before `finish`, no chunks after `finish`, tool-call `arguments` as a raw JSON string, `argumentsDelta` for streaming, block `index` assigned on first appearance and reused, errors only via `LlmError` or `finish {kind:'error'|'aborted'}`, respects `options.signal`, unsupported options raise `UNSUPPORTED_OPTION`); every request carries the dsh-llm-mandated `attributionHeaders()` attribution headers (colliding custom headers yield, with a build-time warn). Image attachments are not supported in v1: an image block raises `UNSUPPORTED_OPTION`.

## OAuth credential handling and limits

- access token **unexpired** (or no `expires`) → used directly as a bearer key;
- **expired but with a refresh token** → seeded into pi-ai's **in-memory** `CredentialStore`, refreshed on request by pi-ai's own OAuth refresh mechanism; refreshed tokens live only in memory and are **never written back** to `auth.json`. Note: refresh capability comes from the provider's own OAuth definition in the pi-ai built-in catalog, so it only works for catalog providers (e.g. anthropic, openai-codex); if refresh fails, that provider's requests fail with an error — log in again on the pi side to recover;
- expired with no refresh token → the provider is skipped with a warn;
- a custom provider (not in the pi-ai catalog) holding only expired OAuth → cannot be refreshed, skipped at build time with a warn (never registered as a doomed 401 route);
- `includeOAuth: false` disables OAuth bridging entirely.

## Differences from `@deepseek-ai/dsh-llm-pi-ai`

| | dsh-llm-pi-ai (official) | pi-auth-bridge (this plugin) |
|---|---|---|
| Credential source | harness-owned credential store / login flows (`ctx.credentials`, OAuth login) | reuses the local pi `auth.json` login state |
| Configuration | settings seam, per-field profile overrides of the catalog | zero config (only 5 optional knobs) |
| Credential persistence | writes to the harness credential store | never writes any file, pure memory |
| Retries | works with dsh-llm-retry / retry policy | none (`maxRetries: 0`) |
| Images | supported (via dsh-attachment) | not in v1, explicit `UNSUPPORTED_OPTION` |
| Custom providers | declared in settings.yaml | reuses pi's `models.json` directly |

In one sentence: the official adapter targets the harness-owned credential/login system; this plugin treats pi as the auth source and does a one-shot, read-only bridge.

## Security notes

- **Read-only** on pi config files: nothing under `~/.pi` (or `$PI_CODING_AGENT_DIR`) is created, modified, or deleted;
- credentials stay in process memory throughout: no `ctx.credentials.set` calls, nothing in the dsh credential store, no temp files, and OAuth refresh results are never written back;
- `"!cmd"` value commands come from pi's own config files (the same commands pi itself would run), with a 10s default timeout and in-memory-only result caching;
- warnings/logs never contain credential material.

## Disclaimer

- This plugin is only a **read-only local config bridge**: it reads pi's existing login state on your machine and forwards it to dsh in memory only. It ships no credentials, bypasses no paywall, and defeats no authentication.
- **Bridging plain API keys** carries no terms-of-service risk — keys are designed to be used by any client.
- **Subscription-backed OAuth tokens are different**: some vendors explicitly restrict them to their official clients. For example, Anthropic's Consumer Terms of Service limit Free/Pro/Max OAuth tokens to Claude Code and Claude.ai; using them in any third-party tool is a violation, and account bans have been publicly reported. Whether and how you use such tokens through this bridge in dsh is **your own decision and your own risk** (including, without limitation, account restriction or suspension).
- Read and comply with each provider's terms of service before use; `includeOAuth: false` disables OAuth bridging entirely, leaving only the API key path.
- This project is not affiliated with or endorsed by pi, Anthropic, OpenAI, DeepSeek, or any other vendor. Nothing in this section constitutes legal advice.

## Platform support

- **Linux / macOS**: default directory `~/.pi/agent`;
- **Windows**: default directory `%USERPROFILE%\.pi\agent` (`os.homedir()` is inherently cross-platform);
- both platforms accept a `$PI_CODING_AGENT_DIR` or `piDir` config override;
- path-joining logic is implemented as pure functions with injectable `env` / `homedir` / `joinPath`, and both win32 and posix samples are covered by unit tests.

## Development and testing

```bash
npm run typecheck   # tsc --noEmit, zero errors under strict mode
npm run build       # tsc -p tsconfig.build.json → dist/
npm test            # vitest run, 72 test cases
```

All tests use temp-directory fixtures and mocks (injected `execCmd`, fake pi-ai streams); they never touch the real `~/.pi` and never access the network.

## License

[MIT](./LICENSE)
