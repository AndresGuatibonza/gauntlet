// Barrel export for @gauntlet/core -- everything a consumer (the CLI or the
// Next.js web app) needs from the framework-agnostic pipeline: fetching,
// page discovery, extraction, normalization into an Evidence Packet, the
// Opportunity Card contract, and the Scientist/Reviewer Claude API calls.
export * from "./evidence-packet.js";
export * from "./fetcher.js";
export * from "./page-discovery.js";
export * from "./extractor.js";
export * from "./normalizer.js";
export * from "./opportunity-card.js";
export * from "./llm-client.js";
export * from "./scientist.js";
export * from "./reviewer.js";
