import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_EMAIL_RECIPIENTS,
  resolveAgentEmailRecipient,
  agentEmailRecipientMap,
} from "../src/agent-email-recipients.ts";

test("default contact key resolves to contact@gokhan.vc", () => {
  assert.equal(resolveAgentEmailRecipient("contact"), "contact@gokhan.vc");
  assert.equal(resolveAgentEmailRecipient(""), undefined);
  assert.equal(resolveAgentEmailRecipient("  CONTACT  "), "contact@gokhan.vc");
});

test("numetal and ishtar route to contact@numetal.xyz", () => {
  assert.equal(resolveAgentEmailRecipient("numetal"), "contact@numetal.xyz");
  assert.equal(resolveAgentEmailRecipient("ishtar"), "contact@numetal.xyz");
});

test("recipient map matches published inboxes", () => {
  assert.deepEqual(agentEmailRecipientMap(), {
    contact: "contact@gokhan.vc",
    investments: "investments@gokhan.vc",
    gokhanvc: "contact@gokhan.vc",
    numetal: "contact@numetal.xyz",
    ishtar: "contact@numetal.xyz",
  });
  assert.equal(Object.keys(AGENT_EMAIL_RECIPIENTS).length, 5);
});
