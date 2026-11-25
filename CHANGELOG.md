# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-25

### Added

- First public release, extracted from the local `@local/rider-mcp` bundle.
- Per-session MCP client Fibers under the server name `rider`, exposing Rider's
  tools as `mcp__rider__*`.
- Per-session project pinning through the `IJ_MCP_SERVER_PROJECT_PATH` header,
  with per-call `rootFolder` selection as the default.
- Composer badge and panel: live connection state, tool count, project picker,
  disconnect/reconnect, and last `rootFolder` in the tooltip.
- Session choices persisted in `rider-mcp.sessions.json` beside the DSH profile.
- Five-minute default tool-call timeout for long operations such as builds.
- English and Chinese locale metadata for Plugin Manager.
