import { verify, X509Certificate } from "node:crypto";

export class InvalidSnsMessage extends Error {}
type SnsMessage = Record<string, string>;
const certificates = new Map<
  string,
  { certificate: X509Certificate; expiresAt: number }
>();

// AWS's canonical string includes a newline after EVERY value, including Type.
export function snsSigningString(message: SnsMessage): string {
  const fields =
    message.Type === "Notification"
      ? [
          "Message",
          "MessageId",
          ...(message.Subject === undefined ? [] : ["Subject"]),
          "Timestamp",
          "TopicArn",
          "Type",
        ]
      : [
          "Message",
          "MessageId",
          "SubscribeURL",
          "Timestamp",
          "Token",
          "TopicArn",
          "Type",
        ];
  if (fields.some((field) => typeof message[field] !== "string"))
    throw new InvalidSnsMessage("Missing signed field");
  return fields.map((field) => `${field}\n${message[field]}\n`).join("");
}

export function trustedSnsCertificateUrl(value: string, topicArn: string): URL {
  const [, partition, service, region, account] = topicArn.split(":");
  if (
    !["aws", "aws-cn", "aws-us-gov"].includes(partition ?? "") ||
    service !== "sns" ||
    !/^\d{12}$/.test(account ?? "")
  )
    throw new InvalidSnsMessage("Invalid SNS topic");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidSnsMessage("Invalid certificate URL");
  }
  const host = `sns.${region}.amazonaws.com${partition === "aws-cn" ? ".cn" : ""}`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== host ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/SimpleNotificationService-[a-zA-Z0-9_-]+\.pem$/.test(url.pathname)
  )
    throw new InvalidSnsMessage("Untrusted SNS certificate URL");
  return url;
}

async function getCertificate(url: URL): Promise<X509Certificate> {
  const cached = certificates.get(url.href);
  if (cached && cached.expiresAt > Date.now()) return cached.certificate;
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || !response.body)
    throw new Error("SNS certificate download failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384)
        throw new InvalidSnsMessage("SNS certificate too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const certificate = new X509Certificate(Buffer.concat(chunks));
  const now = Date.now();
  if (
    Date.parse(certificate.validFrom) > now ||
    Date.parse(certificate.validTo) <= now
  )
    throw new InvalidSnsMessage("SNS certificate expired or not yet valid");
  if (certificates.size >= 32)
    certificates.delete(certificates.keys().next().value!);
  certificates.set(url.href, {
    certificate,
    expiresAt: Math.min(now + 3600000, Date.parse(certificate.validTo)),
  });
  return certificate;
}

export async function verifySnsMessage(
  input: unknown,
  allowedTopics: string[],
): Promise<SnsMessage> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InvalidSnsMessage("Invalid SNS message");
  const message = input as SnsMessage;
  if (
    !["Notification", "SubscriptionConfirmation"].includes(
      message.Type ?? "",
    ) ||
    !allowedTopics.includes(message.TopicArn ?? "") ||
    !["1", "2"].includes(message.SignatureVersion ?? "") ||
    typeof message.Signature !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(message.Signature) ||
    typeof message.SigningCertURL !== "string"
  )
    throw new InvalidSnsMessage("Invalid SNS envelope");
  const canonical = snsSigningString(message);
  const timestamp = Date.parse(message.Timestamp!);
  if (
    !Number.isFinite(timestamp) ||
    timestamp > Date.now() + 300000 ||
    timestamp < Date.now() - 30 * 86400000
  )
    throw new InvalidSnsMessage("SNS message timestamp outside replay window");
  const certificate = await getCertificate(
    trustedSnsCertificateUrl(message.SigningCertURL, message.TopicArn!),
  );
  if (
    !verify(
      message.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1",
      Buffer.from(canonical),
      certificate.publicKey,
      Buffer.from(message.Signature, "base64"),
    )
  )
    throw new InvalidSnsMessage("Invalid SNS signature");
  return message;
}
