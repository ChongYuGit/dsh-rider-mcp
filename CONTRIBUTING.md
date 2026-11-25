# Contributing

Thanks for taking a look. This bundle is intentionally small: plain ESM, no build
step, no runtime dependencies.

## Before you open a pull request

1. Read `README.md` and keep the session-isolation contract: one MCP client Fiber
   per DSH session, no process-global Rider registration, and every badge route
   scoped by `?session=<SessionId>`.
2. Run the checks:

   ```bash
   node --check index.js
   node --check client.js
   node --check session-runtime.js
   node scripts/check.mjs
   npm pack --dry-run
   ```

3. Test against a real Rider instance with its MCP server enabled, in at least
   one session. Mention what you verified and what you could not.

## Style

- Keep comments about behavior and reasons, not line-by-line narration.
- Keep `locale/en.json` and `locale/zh.json` in sync; add keys to both or to
  neither.
- Do not add dependencies, a bundler, or a generated `dist/` directory. The
  browser entry is hand-written and loaded through DSH's client module loader.
- Do not commit session state (`rider-mcp.sessions.json`), editor files, or
  personal absolute paths.

## Reporting bugs

Include the DSH version, Rider version, the badge state, and the relevant DSH log
lines. Never paste credentials or full local paths you do not want public.

## License

By contributing you agree that your contribution is licensed under the MIT
license in `LICENSE`.
