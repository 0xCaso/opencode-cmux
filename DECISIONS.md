# Decisions

- 2026-11-12 · Ask the contributor to open the PR for #22, with 3 review fixes · we take over the branch ourselves · credit to the contributor, the code was already good · https://github.com/0xCaso/opencode-cmux/issues/22#issuecomment-6822678169
- 2026-11-12 · List opencode-cmux in awesome-ai-plugins under OpenCode Plugins · `platform: standalone` in Tools & Integrations · it installs through OpenCode's `plugins` config · https://github.com/hashgraph-online/awesome-ai-plugins/pull/1316
- 2026-11-12 · Pin CI actions to SHAs, run lsof without a shell, add Dependabot and SECURITY.md, enable private vulnerability reporting · leave the scanner findings · the listing needed 75/100 (we went from 69 to 100) · https://github.com/0xCaso/opencode-cmux/pull/23
- 2026-11-16 · Merge #25 (`resolution: "cwd"`, opt-in) and release 0.5.0 · keep `--standalone` as the only fix · default `"env"` is unchanged and 37/37 tests pass · https://github.com/0xCaso/opencode-cmux/pull/25
