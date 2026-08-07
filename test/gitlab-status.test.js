import assert from "node:assert/strict";
import test from "node:test";
import { remoteFromLink } from "../src/tools/gitlab-status.js";

test("remoteFromLink accepts configured GitLab hosts", () => {
  assert.equal(
    remoteFromLink("https://gitlab.solunika.com/group/project/-/tree/main"),
    "git@gitlab.solunika.com:group/project.git",
  );
});

test("remoteFromLink rejects untrusted hosts", () => {
  assert.throws(
    () => remoteFromLink("https://evil.example/group/project/-/tree/main"),
    /is not allowed/,
  );
});
