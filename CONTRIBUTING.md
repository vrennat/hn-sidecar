# Contributing

## Workflow

1. Open an issue or comment on an existing one to discuss the change before
   writing code.
2. Fork the repo, create a branch (`feature/`, `fix/`, or `refactor/`).
3. Make your changes.
4. Add or update tests as needed.
5. Run `bun run typecheck` and `bun test` — both must pass.
6. Commit with a [conventional commit](https://www.conventionalcommits.org/)
   message:
   - `feat:` — new capability
   - `fix:` — bug fix
   - `refactor:` — code change with no behavior change
   - `docs:` — documentation only
   - `test:` — test additions or changes
   - `chore:` — tooling, CI, dependencies
7. Push and open a pull request against `main`.

## Tests

- Tests use bun's built-in test runner (`bun test`).
- Test files are colocated with source as `*.test.ts`.
- The golden vectors in `packages/shared/src/vectors.ts` define the contract
  for URL normalization and hashing. Do not change them without also changing
  the corresponding frozen hashes in `packages/shared/src/frozen.ts`.
- If your change affects URL normalization, add test vectors for your edge
  cases.

## Pull request guidelines

- Keep PRs small and focused on one concern.
- Include a clear description of what the change does and why.
- If the PR changes behavior visible to the user, describe the before/after.
- Do not replace test fixtures without a reason stated in the PR description.

## Licensing

By contributing, you agree that your contributions will be licensed under the
MIT license as described in [LICENSE](LICENSE).
