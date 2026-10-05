import { getRedis, redisKey } from "../redis";
import { UnrecoverableError } from "bullmq";

// One regional budget shared by every worker and both email queues. Redis TIME
// avoids clock skew between replicas; a rolling window avoids boundary bursts.
export const RESERVE_RECIPIENTS = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local rate = tonumber(ARGV[1])
local count = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - 1000)
local used = redis.call('ZCARD', KEYS[1])
if used + count > rate then
  local release = redis.call('ZRANGE', KEYS[1], used + count - rate - 1, used + count - rate - 1, 'WITHSCORES')
  return math.max(1, tonumber(release[2]) + 1000 - now)
end
for i = 1, count do
  redis.call('ZADD', KEYS[1], now, ARGV[3] .. ':' .. i)
end
redis.call('PEXPIRE', KEYS[1], 2000)
return 0
`;

export async function reserveSendBudget(
  region: string,
  rate: number,
  recipients: number,
) {
  if (
    !Number.isInteger(rate) ||
    rate < 1 ||
    recipients < 1 ||
    recipients > rate
  ) {
    throw new UnrecoverableError(
      "Recipient count exceeds the configured regional send rate; split the message or raise the configured rate within the SES quota",
    );
  }
  return Number(
    await getRedis().eval(
      RESERVE_RECIPIENTS,
      1,
      redisKey(`ses-send-budget:${region}`),
      rate,
      recipients,
      crypto.randomUUID(),
    ),
  );
}

export function isExplicitSesThrottle(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    ["Throttling", "ThrottlingException", "TooManyRequestsException"].includes(
      value.name ?? "",
    ) && value.$metadata?.httpStatusCode === 429
  );
}
