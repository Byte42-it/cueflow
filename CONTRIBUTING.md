# Contributing to Cueflow

Thank you for helping make UI guides easier to maintain. Bug reports, documentation, example kits, translations and code improvements are welcome. Use English for shared documentation and pull requests where possible.

## Before submitting

1. For bugs, describe the expected and actual behavior, Node.js version and a minimal reproduction using synthetic data.
2. For substantial features or new dependencies, open an issue first to discuss scope.
3. Keep pull requests focused and explain the problem, resulting behavior and relevant validation.
4. For code changes, run `npm run typecheck` and `npm test`. Build the demo when changing guide generation; inspect playback and seeking when changing the player. Report checks you could not run.

Keep the browser player dependency-free, preserve playback and seek behavior, and make errors useful to both humans and MCP clients. Do not submit secrets, private documents or customer data.

## Required AI assistance disclosure

AI-assisted contributions are welcome. **Every pull request must contain an AI assistance disclosure**, including contributions to documentation, tests, translations and assets. If no AI was used, write `None — no AI assistance`.

When AI was used, disclose:

- **Agent/tool:** for example Codex, Claude Code, GitHub Copilot or another tool; list all that materially contributed.
- **Model/version:** when available; write `unknown` if the tool does not expose it.
- **Scope:** which files or tasks were assisted, such as implementation, review, tests, documentation or image generation.
- **Human verification:** what you reviewed and which checks you ran, including remaining limitations.

Example:

```text
Agent/tool: Codex
Model/version: unknown
Scope: README edits and a player bug fix; test suggestions.
Human verification: reviewed the diff, ran typecheck and tests, checked demo playback and seeking.
```

You do not need to publish private prompts, conversation transcripts or credentials. Maintainers may request missing disclosure or verification before merging. Disclosure does not replace review: the contributor remains responsible for correctness, provenance and the right to submit the material. Do not list an AI tool as a human reviewer or imply that it approved the change.

## License of contributions

By submitting a contribution, you agree to license it under this repository's [MIT License](LICENSE) and confirm you have the right to do so. Identify any third-party code or assets and their licenses in the PR. No separate copyright assignment or contributor license agreement is required.

Be respectful in issues and reviews. Explain disagreements with concrete examples and help others reproduce problems.
