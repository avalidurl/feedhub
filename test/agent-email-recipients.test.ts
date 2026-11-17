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

test("numetal and ishtar route to contact@gokhan.vc", () => {
  assert.equal(resolveAgentEmailRecipient("numetal"), "contact@gokhan.vc");
  assert.equal(resolveAgentEmailRecipient("ishtar"), "contact@gokhan.vc");
});

test("recipient map matches published inboxes", () => {
  assert.deepEqual(agentEmailRecipientMap(), {
    contact: "contact@gokhan.vc",
    investments: "contact@gokhan.vc",
    gokhanvc: "contact@gokhan.vc",
    numetal: "contact@gokhan.vc",
    ishtar: "contact@gokhan.vc",
  });
  assert.equal(Object.keys(AGENT_EMAIL_RECIPIENTS).length, 5);
});
