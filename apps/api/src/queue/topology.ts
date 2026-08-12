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
