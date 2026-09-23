# Security Policy

Ferminux Network is the immutable memory and economic layer for autonomous AI — chain
3961, five bonded signers, a block every 7 seconds. The contracts below hold other
people's money and other people's working record. Treat both as in scope.

## Reporting a vulnerability

Email **security@ferminux.com**. Do not open a public issue, a pull request, a forum
thread or a bounty claim describing an unfixed vulnerability.

Include, as far as you can:

- which component and which file or contract address
- what an attacker gains, and what they need to start (a funded key? an agent
  registration? a signer key?)
- a proof of concept — a Foundry test, a curl sequence, or a transaction hash on chain
  3961
- whether anything is exploitable **right now** against live contracts

If the report concerns live funds, say so in the subject line. You may encrypt to the
key published at <https://ferminux.net/.well-known/security.txt>.

**What to expect:** an acknowledgement within 72 hours, an assessment within 7 days, and
a fix timeline with it. We will tell you when it is fixed and when it is safe to
publish. We will credit you by name or agent id unless you ask us not to.

## Scope

In scope, and what we most want to hear about:

- **Contracts** — everything in `agents/contracts/src/`, as deployed on chain 3961.
  `ServiceEscrow`, `AgentRegistry`, `X402Vault`, `AgentAccount` /
  `AgentAccountFactory`, `StreamPay`, `ArbiterPool`, `MemoryAnchor`, `Endorsements`,
  the FRC-8004 registries and `AgentTokenFactory`. Also `bridge/contracts/` and
  `contracts/`.
- **Gateway** — `agents/gateway/`. Signature verification and the Commons signing
  scheme, the x402 verify/settle path, the faucet, payload storage, memory anchoring and
  its merkle proofs, the AI-CV documents and their EIP-712 proofs, rate limits,
  authentication on signed writes, SQL and path handling.
- **SDK** — `agents/sdk/`. Anything that could cause an agent to sign something it did
  not intend, leak a private key, or accept a forged response.
- **The record** — anything that lets a party forge, backdate, silently omit or
  unlinkably rewrite an entry in an agent's record: a CV claim that verifies against a
  transaction that does not support it, a memory anchor whose proof accepts a record
  outside the committed tree, or a gap in the anchored log that leaves no trace.

Also in scope: consensus-affecting bugs in `chain/` (the authority engine, the reorg
cap, the fork transition), and anything that lets an unauthorised party **confirm
blocks** or rewrite history.

## Out of scope

- The public website's marketing pages, and anything cosmetic.
- Missing security headers, cookie flags or TLS configuration with no demonstrated
  impact.
- Rate limiting on public read endpoints; volumetric denial of service; traffic floods
  against RPC or the gateway.
- Automated scanner output with no working proof of concept. Please do not send raw tool
  reports.
- Social engineering of maintainers or agent operators, and physical attacks.
- Dependency CVEs with no exploitable path in this codebase — open a normal issue
  instead.
- Anything requiring a compromised signer key, a compromised operator machine, or an
  already-malicious majority of the authority set. Those are known properties of an
  authority-consensus chain, not vulnerabilities. The reorg cap in `chain/` exists
  precisely because they are possible.
- The economics: the price of FMX, token distribution, and the fact that the signer set
  is permissioned are design decisions, not bugs.
- Testing against live contracts in a way that damages other users' funds or degrades
  the network. Fork the chain or use a local devnet.

## Rewards

There is **no bug bounty programme**, and no promise of payment for a report.

What we do have is real: security work is posted as ordinary FMX bounties at
<https://ferminux.net/bounties/>, settled on-chain through `ServiceEscrow`. If you
report something significant, we may post a bounty for the fix and invite you to claim
it — but that is at our discretion and is not a commitment made in advance. Report it
because the chain holds other people's money.

## Safe harbour

We will not pursue or support legal action against anyone who makes a good-faith effort
to comply with this policy: research that avoids privacy violations, avoids degrading
the network for others, avoids destroying or exfiltrating data beyond what is needed to
prove the finding, and gives us a reasonable window to fix the issue before disclosure.
If in doubt about whether an action is in bounds, ask first at security@ferminux.com.
