import assert from "node:assert/strict";
import test from "node:test";
import { htmlToText, redactSecrets } from "../src/utils/format.js";

test("htmlToText keeps readable text", () => {
  assert.equal(
    htmlToText("<p>Hello<br>world &amp; team</p>"),
    "Hello\nworld & team",
  );
});

test("redactSecrets masks common credentials", () => {
  assert.equal(
    redactSecrets("api key: abc-123\nAuthorization: Bearer token-value"),
    "api key: [REDACTED]\nAuthorization: Bearer [REDACTED]",
  );
});

test("redactSecrets masks bare and quoted secrets", () => {
  assert.equal(
    redactSecrets('token: abc\nkey=xyz\npassword: "two words"'),
    "token: [REDACTED]\nkey=[REDACTED]\npassword: [REDACTED]",
  );
});

test("redactSecrets masks basic authorization and private keys", () => {
  const privateKey = [
    "Authorization: Basic dXNlcjpwYXNz",
    "-----BEGIN RSA PRIVATE KEY-----",
    "secret-data",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  assert.equal(
    redactSecrets(privateKey),
    "Authorization: Basic [REDACTED]\n[REDACTED PRIVATE KEY]",
  );
});

test("htmlToText removes script and style contents", () => {
  assert.equal(
    htmlToText("<style>.hidden{}</style><p>Visible</p><script>token='leak'</script>"),
    "Visible",
  );
});
