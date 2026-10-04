import { expect, test } from "bun:test"

import { catalogSummary, ModelCatalog, modelSupportsEndpoint } from "~/models"

import { config, FakeUpstream } from "./helpers"

test("legacy catalog entries infer chat and embeddings without assuming native protocols", () => {
  const chat = { id: "legacy-chat", capabilities: { type: "chat" } }
  const embedding = {
    id: "legacy-embedding",
    capabilities: { type: "embeddings" },
  }
  expect(modelSupportsEndpoint(chat, "/chat/completions")).toBeTrue()
  expect(modelSupportsEndpoint(chat, "/v1/messages")).toBeFalse()
  expect(modelSupportsEndpoint(chat, "/responses")).toBeFalse()
  expect(modelSupportsEndpoint(embedding, "/embeddings")).toBeTrue()
  expect(modelSupportsEndpoint(embedding, "/chat/completions")).toBeFalse()
  expect(
    modelSupportsEndpoint(
      { ...chat, supported_endpoints: ["/responses"] },
      "/chat/completions",
    ),
  ).toBeFalse()
})

test("generic diagnostics work without any Claude model and distinguish catalog from access", () => {
  const summary = catalogSummary([
    { id: "chat", capabilities: { type: "chat" } },
    { id: "responses", supported_endpoints: ["/responses"] },
    { id: "embed", capabilities: { type: "embeddings" } },
    {
      id: "disabled",
      supported_endpoints: ["/v1/messages"],
      policy: { state: "disabled" },
    },
  ])
  expect(summary.catalogModels).toBe(4)
  expect(summary.policyAllowedModels).toBe(3)
  expect(summary.protocols).toEqual({
    chatCompletions: ["chat"],
    responses: ["responses"],
    messages: [],
    embeddings: ["embed"],
  })
  expect(summary.availability).toContain("Catalog metadata only")
})

test("legacy capability types cannot send embeddings to chat or completion models to embeddings", () => {
  const catalog = new ModelCatalog(new FakeUpstream(), config())
  expect(() =>
    catalog.validate(
      { id: "embed", capabilities: { type: "embeddings" } },
      "/chat/completions",
      {},
    ),
  ).toThrow("does not support")
  expect(() =>
    catalog.validate(
      { id: "completion", capabilities: { type: "completion" } },
      "/embeddings",
      {},
    ),
  ).toThrow("does not support")
})
