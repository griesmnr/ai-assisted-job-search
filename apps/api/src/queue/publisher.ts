/**
 * Publishing side of `fetch.source` (ticket 4f88339, design c54b9e0 §4.1).
 *
 * `POST /searches` is now a PUBLISHER, not a worker: it records the search
 * durably and then hands one `fetch.source` message per selected source to
 * RabbitMQ. This module is the seam between the route and the broker —
 * injected into `registerSearchRoutes` the same way `resolveSourceIds`
 * already is (index.ts's `BuildAppDeps`), so route tests can assert what
 * WOULD have been published without a live broker, and production gets the
 * real thing with no test-only branch inside the handler.
 *
 * WHY PER-SOURCE ATTRIBUTION MATTERS ENOUGH TO CONFIRM ONE AT A TIME: the
 * route's failure handling (§4.1 step 5) marks the individual
 * `search_sources` row `failed` / `dispatch-failed` for a source whose
 * message could not be published, so the other sources' results still come
 * back and the search still terminates. A single batched
 * `waitForConfirms()` over N publishes would tell us only "something in
 * that batch failed", which would force marking all N failed — turning one
 * broker hiccup into a whole dead search. N is the number of sources a
 * user ticked (at most a handful, and capped by the source registry), so N
 * small round trips is a real cost we can afford for exact attribution.
 */
import amqp, { type ChannelModel, type ConfirmChannel } from "amqplib";
import { JOBS_EXCHANGE, type FetchSourceMessage } from "../worker/fetchSourceWorker.js";

/** The routing key `fetch.source` messages are published under — the same
 * key `setupTopology()` binds the `fetch.source` queue to the "jobs"
 * exchange with (queue/topology.ts). */
export const FETCH_SOURCE_ROUTING_KEY = "fetch.source";

/** One source that could not be dispatched, and why. `sourceId` is the
 * `Job["dataSource"]` value, i.e. the `search_sources.source_descriptor_id`
 * the route marks `failed`. */
export type DispatchFailure = { sourceId: string; error: string };

/**
 * Publishes every message and reports which ones did not make it.
 *
 * NEVER REJECTS for a per-message failure — a broker problem affecting one
 * source must not take the whole request down, because the other sources'
 * messages may well have been published successfully and their work is
 * already in flight. It may still reject if the connection itself cannot
 * be established at all, which the route treats as "every source failed to
 * dispatch".
 */
export type PublishFetchSourceFn = (
  messages: readonly FetchSourceMessage[],
) => Promise<DispatchFailure[]>;

function amqpUrl(): string {
  // Same shape setupTopology() builds (queue/topology.ts). Duplicated
  // rather than exported from there on purpose: importing topology.ts
  // would pull its `setupTopology` (which ASSERTS every queue) into the
  // API process's module graph, and declaring topology is a deploy step,
  // not something an HTTP server should be able to do as a side effect of
  // an import.
  return (
    `amqp://${process.env.RABBITMQ_DEFAULT_USER}:${process.env.RABBITMQ_DEFAULT_PASS}` +
    `@${process.env.RABBITMQ_HOST}:${process.env.RABBITMQ_PORT}`
  );
}

/**
 * Publishes one message and waits for the broker's confirm.
 *
 * `mandatory: true` + the one-shot `return` listener is the same safety
 * net both workers already use on their retry publishes
 * (fetchSourceWorker.ts's `ensureRetryReturnHandler`): a publish to an
 * exchange with no matching binding is NOT an error in AMQP — it succeeds,
 * `waitForConfirms()` resolves, and the message is silently dropped. That
 * is the single worst outcome available here: the route would 202, the
 * `search_sources` row would sit `pending` forever, and the search would
 * hang until the stall backstop noticed 45 minutes later. `mandatory`
 * turns it into a `return` event, which this turns into a real dispatch
 * failure the route can mark on the row immediately.
 */
async function publishOne(channel: ConfirmChannel, message: FetchSourceMessage): Promise<void> {
  let returned = false;
  const onReturn = (): void => {
    returned = true;
  };
  channel.on("return", onReturn);
  try {
    channel.publish(JOBS_EXCHANGE, FETCH_SOURCE_ROUTING_KEY, Buffer.from(JSON.stringify(message)), {
      persistent: true,
      contentType: "application/json",
      mandatory: true,
    });
    await channel.waitForConfirms();
  } finally {
    channel.removeListener("return", onReturn);
  }
  if (returned) {
    throw new Error(
      `fetch.source publish for sourceId "${message.sourceId}" was unroutable — the ` +
        `"${FETCH_SOURCE_ROUTING_KEY}" binding on the "${JOBS_EXCHANGE}" exchange is missing. ` +
        `Run setupTopology() before starting the API.`,
    );
  }
}

/**
 * The real, AMQP-backed publisher.
 *
 * LAZY, like `BuildAppDeps.getScoreJob` and for the same reason: building
 * this at server boot would make a running RabbitMQ a precondition for
 * `GET /sources`, `GET /resumes/:id/results` and every other free route.
 * The connection is established on the first `POST /searches` and cached
 * for the process's life; if it drops, the cache is cleared so the next
 * request reconnects rather than publishing into a dead channel forever.
 */
export function createAmqpFetchSourcePublisher(): PublishFetchSourceFn {
  let pending: Promise<{ connection: ChannelModel; channel: ConfirmChannel }> | undefined;

  async function connect(): Promise<{ connection: ChannelModel; channel: ConfirmChannel }> {
    const connection = await amqp.connect(amqpUrl());
    const channel = await connection.createConfirmChannel();
    // Any failure on either object invalidates the cache. Without this, a
    // broker restart leaves every later publish throwing "channel closed"
    // with no path back short of restarting the API.
    const invalidate = (): void => {
      pending = undefined;
    };
    connection.on("close", invalidate);
    connection.on("error", invalidate);
    channel.on("close", invalidate);
    channel.on("error", invalidate);
    return { connection, channel };
  }

  return async function publishFetchSource(messages) {
    if (messages.length === 0) return [];
    // Assigned before awaiting so two concurrent requests share one
    // connection attempt instead of opening two.
    pending ??= connect().catch((err: unknown) => {
      pending = undefined;
      throw err;
    });
    const { channel } = await pending;

    const failures: DispatchFailure[] = [];
    for (const message of messages) {
      try {
        await publishOne(channel, message);
      } catch (err) {
        failures.push({
          sourceId: message.sourceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return failures;
  };
}
