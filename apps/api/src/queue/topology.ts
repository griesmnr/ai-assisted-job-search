import amqp from "amqplib";

export async function setupTopology() {
  const url = `amqp://${process.env.RABBITMQ_DEFAULT_USER}:${process.env.RABBITMQ_DEFAULT_PASS}@${process.env.RABBITMQ_HOST}:${process.env.RABBITMQ_PORT}`;

  const connection = await amqp.connect(url);
  const channel = await connection.createConfirmChannel();

  //the exchange every producer publishes to.
  await channel.assertExchange("jobs", "direct", { durable: true });

  //the dead letter exchange failures get republished to.
  await channel.assertExchange("jobs.dlx", "direct", { durable: true });

  //the work queue - note what its wired to on failure
  await channel.assertQueue("fetch.source", {
    durable: true,
    deadLetterExchange: "jobs.dlx",
    deadLetterRoutingKey: "fetch.source",
  });

  //the binding: exchange -> queue, for this routing key.
  await channel.bindQueue("fetch.source", "jobs", "fetch.source");

  // the dead letter queue
  await channel.assertQueue("fetch.source.dlq", { durable: true });
  await channel.bindQueue("fetch.source.dlq", "jobs.dlx", "fetch.source");

  // the retry queue - backoff, not failure. RabbitMQ has no native
  // delayed-delivery, so a failed-but-retryable fetch.source message is
  // republished here (never bound to "jobs", so it's never delivered
  // straight from a normal consume) with a per-message `expiration` set by
  // the worker for that attempt's backoff. Nothing consumes this queue -
  // messages just sit until their TTL fires, at which point RabbitMQ
  // dead-letters them itself, per deadLetterExchange/deadLetterRoutingKey
  // below, straight back into the "fetch.source" work queue for another
  // attempt. The worker tracks the attempt count itself (RabbitMQ has no
  // built-in counter) via an `x-attempt` header on the message and gives up
  // - nack(msg, false, false) into fetch.source.dlq above - once it's
  // exhausted.
  await channel.assertQueue("fetch.source.retry", {
    durable: true,
    deadLetterExchange: "jobs",
    deadLetterRoutingKey: "fetch.source",
  });

  await channel.assertQueue("score.job", {
    durable: true,
    deadLetterExchange: "jobs.dlx",
    deadLetterRoutingKey: "score.job",
  });

  await channel.bindQueue("score.job", "jobs", "score.job");

  await channel.assertQueue("score.job.dlq", { durable: true });
  await channel.bindQueue("score.job.dlq", "jobs.dlx", "score.job");

  return { connection, channel };
}
