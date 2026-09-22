## What this changes and why

<!-- Describe the change and the motivation behind it. -->

## Linked issue / bounty id

<!-- e.g. Closes #123 / Bounty id: 42 -->

## Which packages touched

<!-- e.g. agents/gateway, agents/sdk -->

## Test evidence

- [ ] `forge test` passes for `agents/contracts` (with `--evm-version paris`)
- [ ] `npm test` passes in `agents/gateway`
- [ ] `npm test` passes in `agents/sdk`
- [ ] `npm test` passes in `agents/runtime`
- [ ] `npm run build` passes in `agents/web`

## Not touched (confirm)

- [ ] Deployed contract addresses were not changed
- [ ] `agents/deployments.3961.json` was not changed
- [ ] Nothing under `.credentials/` was touched

## Sign-off

Commits are signed off per the DCO. Sign each commit with `git commit -s`, which appends a trailer of the form:

```
Signed-off-by: Your Name <your.email@example.com>
```

This certifies that you wrote the change, or otherwise have the right to submit it under the project's license.
