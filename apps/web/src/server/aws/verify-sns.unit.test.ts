import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sign } from "node:crypto";
import {
  InvalidSnsMessage,
  snsSigningString,
  trustedSnsCertificateUrl,
  verifySnsMessage,
} from "./verify-sns";

const topic = "arn:aws:sns:us-west-1:123456789012:email-events";
const certUrl =
  "https://sns.us-west-1.amazonaws.com/SimpleNotificationService-test.pem";
let dir: string;
let certificate: string;
let key: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sns-signature-test-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=test",
    ],
    { stdio: "ignore" },
  );
  certificate = readFileSync(join(dir, "cert.pem"), "utf8");
  key = readFileSync(join(dir, "key.pem"), "utf8");
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(certificate)),
  );
});
function message(version = "2", type = "Notification") {
  const value: Record<string, string> = {
    Type: type,
    Message: "hello\nworld",
    MessageId: "id-1",
    Timestamp: new Date().toISOString(),
    TopicArn: topic,
    SignatureVersion: version,
    SigningCertURL: certUrl,
  };
  if (type === "SubscriptionConfirmation") {
    value.Token = "test-token";
    value.SubscribeURL = "https://sns.us-west-1.amazonaws.com/confirmation";
  }
  value.Signature = sign(
    version === "2" ? "RSA-SHA256" : "RSA-SHA1",
    Buffer.from(snsSigningString(value)),
    key,
  ).toString("base64");
  return value;
}
describe("SNS authentication", () => {
  it.each(["1", "2"])(
    "verifies real RSA signatures version %s",
    async (version) => {
      const value = message(version);
      await expect(verifySnsMessage(value, [topic])).resolves.toEqual(value);
    },
  );
  it("verifies signed subscription confirmations", async () => {
    await expect(
      verifySnsMessage(message("2", "SubscriptionConfirmation"), [topic]),
    ).resolves.toHaveProperty("Token", "test-token");
  });
  it("retains the final newline and optional subject in the signed bytes", () => {
    expect(snsSigningString({ ...message(), Subject: "subject" })).toContain(
      "Subject\nsubject\nTimestamp\n",
    );
    expect(snsSigningString(message()).endsWith("Type\nNotification\n")).toBe(
      true,
    );
  });
  it("rejects payload tampering", async () => {
    await expect(
      verifySnsMessage({ ...message(), Message: "tampered" }, [topic]),
    ).rejects.toBeInstanceOf(InvalidSnsMessage);
  });
  it("checks the topic allowlist before fetching a certificate", async () => {
    await expect(verifySnsMessage(message(), [])).rejects.toBeInstanceOf(
      InvalidSnsMessage,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    "http://sns.us-west-1.amazonaws.com/SimpleNotificationService-test.pem",
    "https://sns.us-west-1.amazonaws.com.evil.test/SimpleNotificationService-test.pem",
    "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem",
    "https://sns.us-west-1.amazonaws.com:8443/SimpleNotificationService-test.pem",
    "https://sns.us-west-1.amazonaws.com/other.pem",
    "https://user@sns.us-west-1.amazonaws.com/SimpleNotificationService-test.pem",
    "https://sns.us-west-1.amazonaws.com/SimpleNotificationService-test.pem?redirect=evil",
    "https://127.0.0.1/SimpleNotificationService-test.pem",
  ])("rejects an untrusted certificate location: %s", (url) => {
    expect(() => trustedSnsCertificateUrl(url, topic)).toThrow(
      InvalidSnsMessage,
    );
  });
  it("reuses a verified certificate without a request per notification", async () => {
    await verifySnsMessage(message(), [topic]);
    vi.mocked(fetch).mockClear();
    await verifySnsMessage(message(), [topic]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
