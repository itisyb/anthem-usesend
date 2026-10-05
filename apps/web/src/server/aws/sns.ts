import {
  SNSClient,
  CreateTopicCommand,
  SubscribeCommand,
  DeleteTopicCommand,
  ConfirmSubscriptionCommand,
} from "@aws-sdk/client-sns";
import { env } from "~/env";
import { getAwsCredentialOptions } from "~/server/aws/credentials";

function getSnsClient(region: string) {
  return new SNSClient({
    endpoint: env.AWS_SNS_ENDPOINT,
    region: region,
    ...getAwsCredentialOptions(),
  });
}

export async function confirmSubscription(
  topicArn: string,
  token: string,
  region: string,
) {
  await getSnsClient(region).send(
    new ConfirmSubscriptionCommand({ TopicArn: topicArn, Token: token }),
  );
}

export async function createTopic(topic: string, region: string) {
  const client = getSnsClient(region);
  const command = new CreateTopicCommand({
    Name: topic,
  });

  const data = await client.send(command);
  return data.TopicArn;
}

export async function deleteTopic(topicArn: string, region: string) {
  const client = getSnsClient(region);
  await client.send(new DeleteTopicCommand({ TopicArn: topicArn }));
}

export async function subscribeEndpoint(
  topicArn: string,
  endpointUrl: string,
  region: string,
) {
  const subscribeCommand = new SubscribeCommand({
    Protocol: "https",
    TopicArn: topicArn,
    Endpoint: endpointUrl,
  });
  const client = getSnsClient(region);

  const data = await client.send(subscribeCommand);
  return data.SubscriptionArn;
}
