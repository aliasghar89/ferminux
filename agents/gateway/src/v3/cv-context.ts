// The AI-CV's JSON-LD context and JSON Schema, served as JSON.
//
// These two URLs are named inside every credential this gateway issues, and
// until now both answered `200 text/html` — the site's SPA fallback. That is
// worse than a 404: a tool that follows the link sees success and gets a web
// page, so the document is not self-describing to anything that did not already
// know what Ferminux is. They are served from the gateway rather than the static
// site because content type is the whole point of them and the gateway is where
// we control it.
//
// The cryptosuite `eip712-jcs-2026` is still not a registered Data Integrity
// suite, and `proofValue` still carries 0x-hex rather than multibase, so a
// generic VC verifier will refuse the proof. That is stated in the context
// itself rather than left for a reader to discover.
import type { FastifyInstance } from "fastify";
import { CHAIN } from "../constants.js";

export const AICV_NS = "/api/ns/aicv/v1";
const V = "https://ferminux.net/api/ns/aicv/v1";

export const AICV_CONTEXT = {
  "@context": {
    "@version": 1.1,
    "@protected": true,
    fmx: `${V}#`,
    FerminuxAgentCV: {
      "@id": "fmx:FerminuxAgentCV",
      "@context": {
        "@protected": true,
        claimsRoot: "fmx:claimsRoot",
        documentHash: "fmx:documentHash",
        issuedAt: "fmx:issuedAt",
        expiresAt: "fmx:expiresAt",
        asOfBlock: "fmx:asOfBlock",
        hashing: { "@id": "fmx:hashing", "@type": "@json" },
        links: { "@id": "fmx:links", "@type": "@json" },
      },
    },
    AutonomousAgent: {
      "@id": "fmx:AutonomousAgent",
      "@context": {
        "@protected": true,
        agent: { "@id": "fmx:agent", "@type": "@json" },
        summary: { "@id": "fmx:summary", "@type": "@json" },
        record: { "@id": "fmx:record", "@type": "@json", "@container": "@list" },
        recordMeta: { "@id": "fmx:recordMeta", "@type": "@json" },
        counts: { "@id": "fmx:counts", "@type": "@json" },
      },
    },
    FerminuxChainAnchor: "fmx:FerminuxChainAnchor",
    FerminuxRegistryPointer2026: "fmx:FerminuxRegistryPointer2026",
    FerminuxCvRefresh: "fmx:FerminuxCvRefresh",
    DataIntegrityProof: "https://w3id.org/security#DataIntegrityProof",
    cryptosuite: "https://w3id.org/security#cryptosuite",
    proofValue: "https://w3id.org/security#proofValue",
    eip712: { "@id": "fmx:eip712", "@type": "@json" },
    digest: "fmx:digest",
  },
  "fmx:about": {
    name: "Ferminux AI-CV",
    version: "1",
    chainId: CHAIN.chainId,
    schema: `${V}/schema.json`,
    verify: "https://ferminux.net/api/cv/1/verify",
    cryptosuiteWarning:
      "eip712-jcs-2026 is NOT a registered Data Integrity cryptosuite and proofValue carries 0x-hex rather than multibase. A generic VC verifier will refuse this proof. The verification algorithm is reproducible from the document alone — follow the `verify` link or use @ferminux/agent.",
    trustRule: "the signature authenticates the author; the chain authenticates the claim",
  },
} as const;

export const AICV_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `${V}/schema.json`,
  title: "Ferminux AI-CV",
  description: "A verifiable working record of an autonomous agent on Ferminux Network (chain 3961). Every claim names the transaction that proves it.",
  type: "object",
  required: ["@context", "type", "issuer", "validFrom", "validUntil", "credentialSubject", "claimsRoot", "documentHash"],
  properties: {
    "@context": { type: "array", minItems: 2, items: { type: "string" }, description: "the W3C VC 2.0 context first, then this one" },
    type: { type: "array", contains: { const: "FerminuxAgentCV" } },
    id: { type: "string", format: "uri" },
    issuer: { type: "string", pattern: "^did:pkh:eip155:[0-9]+:0x[0-9a-fA-F]{40}$" },
    validFrom: { type: "string", format: "date-time" },
    validUntil: { type: "string", format: "date-time" },
    claimsRoot: { $ref: "#/$defs/bytes32" },
    documentHash: { $ref: "#/$defs/bytes32", description: "keccak256(utf8(JCS(document without `proof` and without `documentHash`)))" },
    credentialSubject: {
      type: "object",
      required: ["id", "type", "agent", "summary", "record"],
      properties: {
        id: { type: "string", pattern: "^did:pkh:eip155:[0-9]+:0x[0-9a-fA-F]{40}$" },
        type: { const: "AutonomousAgent" },
        agent: {
          type: "object",
          required: ["chainId", "agentId", "agentRegistry", "controller"],
          properties: {
            chainId: { type: "integer" },
            agentId: { type: "integer", description: "the identity. Names are not unique on chain and cost nothing." },
            agentRegistry: { $ref: "#/$defs/address" },
            controller: { type: "string" },
          },
        },
        summary: { type: "object", description: "the issuer's arithmetic over record[]. A verifier recomputes it from the claims that actually verified." },
        record: { type: "array", items: { $ref: "#/$defs/claim" } },
        recordMeta: { type: "object", required: ["count", "complete"], properties: { complete: { type: "boolean" }, scope: { type: "object" }, omitted: { type: "array" } } },
      },
    },
    proof: { oneOf: [{ $ref: "#/$defs/proof" }, { type: "array", items: { $ref: "#/$defs/proof" } }] },
  },
  $defs: {
    address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
    bytes32: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
    claim: {
      type: "object",
      required: ["id", "type", "evidence"],
      properties: {
        id: { type: "string" },
        type: {
          type: "string",
          enum: [
            "Registration",
            "AgentState",
            "EscrowJob",
            "X402Receipt",
            "X402Payment",
            "Stream",
            "StreamPayment",
            "SubscriptionPlan",
            "Feedback",
            "Validation",
            "Dispute",
            "Endorsement",
            "Slash",
            "MemoryAnchor",
            "TokenLaunch",
            "Referral",
            "Contribution",
            "Reliability",
            "Capability",
          ],
        },
        leaf: { $ref: "#/$defs/bytes32", description: "keccak256(utf8(JCS(claim without `leaf`)))" },
        evidence: { $ref: "#/$defs/evidence" },
      },
    },
    evidence: {
      type: "object",
      required: ["trust", "proven"],
      properties: {
        trust: { enum: ["chain", "gateway", "selfAttested"] },
        proven: { type: "boolean", description: "true only when a stranger can re-derive the claim from chain 3961 with no Ferminux service in the path" },
        tx: { type: ["string", "null"] },
        blockLogIndex: { type: ["integer", "null"], description: "the BLOCK-scoped index the RPC returns as logs[].logIndex — not a position in the receipt's own array" },
        address: { type: ["string", "null"], description: "MUST be one of the Ferminux contract addresses the verifier pinned in advance" },
        event: { type: "string", description: "full event signature; topic0 must equal keccak256 of it" },
        topic0: { type: ["string", "null"] },
        bind: { type: "array", description: "a courtesy. The verifier owns the bind set; see /api/cv/:id/verify step 7." },
      },
    },
    proof: {
      type: "object",
      required: ["type", "cryptosuite", "verificationMethod", "eip712"],
      properties: {
        type: { const: "DataIntegrityProof" },
        cryptosuite: { const: "eip712-jcs-2026", description: "NOT a registered Data Integrity suite; a generic VC verifier will refuse it" },
        verificationMethod: { type: "string" },
        proofValue: { type: ["string", "null"] },
        eip712: { type: "object" },
      },
    },
  },
} as const;

export function registerCvContextRoutes(app: FastifyInstance): void {
  const cache = "public, max-age=86400";
  app.get(AICV_NS, async (_req, reply) => {
    reply.header("content-type", "application/ld+json; charset=utf-8");
    reply.header("cache-control", cache);
    return reply.send(JSON.stringify(AICV_CONTEXT, null, 2));
  });
  app.get(`${AICV_NS}/schema.json`, async (_req, reply) => {
    reply.header("content-type", "application/schema+json; charset=utf-8");
    reply.header("cache-control", cache);
    return reply.send(JSON.stringify(AICV_SCHEMA, null, 2));
  });
}
