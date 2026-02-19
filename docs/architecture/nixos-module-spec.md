# Agent Harness NixOS Module Spec

Date: 2026-02-18  
Status: proposed

## Scope
Define one NixOS module that runs two binaries from `agent-harness` repo as system services:
- `agent-harness serve` (API + orchestration daemon)
- `agent-harness-receiver serve` (webhook receiver)

No implementation in this doc. Spec only.

## References (patterns to copy)
- `/home/user/dotfiles/nixos/modules/ai-quota.nix`
- `/home/user/dotfiles/nixos/roles/openclaw.nix`
- `/home/user/dotfiles/nixos/roles/agentboard.nix`

Pattern highlights to reuse:
- option-driven config
- wrapper `ExecStart` scripts for secret loading
- `after`/`wants` on `network-online.target` + `tailscaled.service`
- start limits + restart policy
- optional `tailscale serve` oneshot units
- optional watchdog timer for never-down behavior

## Module placement and option root
- File target: `/home/user/dotfiles/nixos/roles/agent-harness.nix`
- Option root: `dotfiles.roles.agentHarness`
- Imported by host files in `/home/user/dotfiles/nixos/hosts/<host>/default.nix`

## Option schema

### Core
- `enable` (bool, default `false`): enable both services
- `repoPath` (str, default `"/home/${dotfiles.username}/repos/agent-harness"`)
- `stateDir` (str, default `"/home/${dotfiles.username}/.agent-harness"`)
- `manageConfig` (bool, default `true`): generate deploy-time config files
- `serviceUser` (str, default `dotfiles.username`)
- `serviceGroup` (str, default `"users"`)

### Binaries
- `binaries.harness` (str, default `"${repoPath}/agent-harness"`)
- `binaries.receiver` (str, default `"${repoPath}/agent-harness-receiver"`)

### Harness daemon options (`harness.*`)
- `port` (port, default `7070`)
- `bindAddress` (str, default `"127.0.0.1"`)
- `requireBearerAuth` (bool, default `true`)
- `tmuxPrefix` (str, default `"ah"`)
- `logLevel` (`debug|info|warn|error`, default `info`)
- `pollIntervalMs` (int, default `1000`)
- `captureLines` (int, default `500`)
- `maxEventHistory` (int, default `10000`)
- `providers` (attrs): provider command/env args map written into harness config
- `webhook.enable` (bool, default `true`)
- `webhook.url` (str, default receiver local endpoint)
- `webhook.events` (list, default `["agent_completed" "agent_error" "agent_exited"]`)
- `webhook.tokenFile` (nullOr path, default `null`) secret file for outbound webhook bearer token

### Receiver options (`receiver.*`)
- `enable` (bool, default `true`)
- `port` (port, default `7071`)
- `bindAddress` (str, default `"127.0.0.1"`)
- `path` (str, default `"/harness-webhook"`)
- `logLevel` (`debug|info|warn|error`, default `info`)
- `auth.tokenFile` (nullOr path, default `null`) inbound webhook bearer token
- `discord.webhookUrlFile` (nullOr path, default `null`)
- `openclaw.gatewayUrl` (str, default `"http://127.0.0.1:18789"`)
- `openclaw.gatewayTokenFile` (nullOr path, default `null`)

### Auth token source (sops/agenix compatible)
- `auth.harnessTokenFile` (nullOr path, default `null`)

Source of truth is always a file path. Host chooses source manager:
- sops-nix: `config.sops.secrets.<name>.path`
- agenix: `config.age.secrets.<name>.path`

Module must not assume one secret manager. It only consumes resolved path.

### Tailscale exposure (`tailscale.*`)
- `mode` enum: `"loopback" | "tailnet-direct" | "tailscale-serve"`
- `tailnetIp` (nullOr str): required when `tailnet-direct`
- `serve.harness.enable` (bool, default `false`)
- `serve.harness.httpsPort` (port, default `9440`)
- `serve.receiver.enable` (bool, default `false`)
- `serve.receiver.httpsPort` (port, default `9441`)

### Service reliability/logging
- `restartPolicy` enum `"always" | "on-failure"` (default `always`)
- `restartSec` (int, default `5`)
- `startLimitBurst` (int, default `5`)
- `startLimitIntervalSec` (int, default `120`)
- `watchdog.enable` (bool, default `true`)
- `watchdog.interval` (str, default `"2min"`)
- `logs.maxRuntimeDays` (int, default `14`) for state-dir prune timer

## Generated files

### 1) Harness config JSON
Path: `${stateDir}/harness.json` (owner `serviceUser`, mode `0600`)

Generated from nix options and written during activation when `manageConfig = true`.
Contains:
- non-secret harness settings (port, tmuxPrefix, log level, poll cadence, provider map)
- webhook structure
- bind target (`bindAddress`) once harness expose host/bind config field; until then prefer loopback + `tailscale serve`

Secret handling:
- `auth.token` is NOT written into JSON.
- wrapper reads `${auth.harnessTokenFile}` and exports `AH_AUTH_TOKEN`.
- if `webhook.tokenFile` set, activation step substitutes token into runtime copy (same placeholder replacement pattern as openclaw).

### 2) Receiver config JSON
Path: `${stateDir}/receiver.json` (owner `serviceUser`, mode `0600`)

Contains non-secret receiver settings and placeholder keys. Activation script replaces placeholders from file-backed secrets.

## Systemd units

### `agent-harness.service`
- `wantedBy = [ "multi-user.target" ]`
- `after = [ "network-online.target" "tailscaled.service" "agent-harness-receiver.service" ]`
- `wants = [ "network-online.target" "tailscaled.service" "agent-harness-receiver.service" ]`
- `Type = simple`
- `User = serviceUser`, `Group = serviceGroup`
- `WorkingDirectory = repoPath`
- `ExecStart = wrapper`:
  - validate binary exists
  - export `HARNESS_CONFIG=${stateDir}/harness.json`
  - load bearer token from `auth.harnessTokenFile` into `AH_AUTH_TOKEN`
  - execute `${binaries.harness} serve`
- `Environment = [ "HOME=/home/${serviceUser}" "NODE_ENV=production" ]`
- `Restart`, `RestartSec`, `StartLimitBurst`, `StartLimitIntervalSec` from options
- `restartIfChanged = false` to avoid killing active orchestrations mid-switch (openclaw/agentboard pattern)

### `agent-harness-receiver.service`
- `wantedBy = [ "multi-user.target" ]`
- `after = [ "network-online.target" "tailscaled.service" ]`
- `wants = [ "network-online.target" "tailscaled.service" ]`
- `Type = simple`
- same user/group and working dir
- `ExecStart = wrapper`:
  - export `AGENT_HARNESS_RECEIVER_CONFIG=${stateDir}/receiver.json`
  - load receiver/auth/openclaw/discord tokens from configured files
  - execute `${binaries.receiver} serve`
- same restart/start-limit policy

### Optional watchdog units
- `agent-harness-watchdog.service` + timer: start harness if not active
- `agent-harness-receiver-watchdog.service` + timer: same for receiver

Follows openclaw/agentboard watchdog pattern.

## Tailscale binding/exposure behavior

### `mode = loopback`
- bind both services to `127.0.0.1`
- no direct firewall ports opened
- recommended default

### `mode = tailnet-direct`
- bind to `tailnetIp`
- open firewall only on `tailscale0` for configured ports
- no `tailscale serve` sidecar units

### `mode = tailscale-serve`
- services still bind loopback
- create oneshot units:
  - `tailscale-serve-agent-harness`
  - `tailscale-serve-agent-harness-receiver`
- unit behavior mirrors openclaw/agentboard:
  - `Type=oneshot`
  - `RemainAfterExit=true`
  - `ExecStartPre=sleep 10`
  - `ExecStart=tailscale serve --https <port> --bg <local-port>`
  - `ExecStop=tailscale serve --https <port> off`

## Secret model (mandatory)
- All bearer/webhook tokens come from files, never inline nix strings.
- Preferred sources:
  - `sops-nix` secret path
  - `agenix` secret path
- Wrapper strips trailing newlines before export.
- Missing required secret file => hard fail startup with clear stderr message.
- Assertions enforce required secrets when auth/webhook integrations enabled.

## Log management
- Primary logs: journald (JSON line logs already emitted by app)
- Unit config:
  - `StandardOutput=journal`
  - `StandardError=journal`
  - `SyslogIdentifier=agent-harness` / `agent-harness-receiver`
- Runtime state logs/artifacts under `${stateDir}/logs`
- Add timer-based prune service deleting files older than `logs.maxRuntimeDays`
- Debug mode controlled by nix option -> config `logLevel = "debug"`

## Assertions and safety checks
- `enable -> binaries.harness exists`
- `receiver.enable -> binaries.receiver exists`
- `harness.requireBearerAuth -> auth.harnessTokenFile != null`
- `tailnet-direct -> tailnetIp != null`
- `webhook.enable && receiver.enable -> webhook.url defaults to receiver local URL`

## Expected host usage example (non-code)
Host sets:
- `dotfiles.roles.agentHarness.enable = true`
- `auth.harnessTokenFile = config.sops.secrets.agent-harness-auth.path` (or `config.age.secrets...`)
- `tailscale.mode = "tailscale-serve"`
- receiver Discord/OpenClaw token file paths

Result:
- both services managed by systemd
- harness API protected by bearer token
- receiver accepts authenticated webhooks
- services reachable on tailnet via `tailscale serve` without public bind

## Acceptance criteria
- One `nixos-rebuild switch` creates both units and starts them.
- Harness health endpoint up and auth enforced on non-health endpoints.
- Receiver gets completion/error/exited webhooks from harness.
- Secret files never appear in nix store or generated JSON without explicit placeholder replacement.
- Service survives crashes with configured restart limits.
- Logs inspectable via `journalctl -u agent-harness -u agent-harness-receiver`.
