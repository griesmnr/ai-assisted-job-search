/**
 * Walks a message through its whole life so you can watch the counters move.
 * Run it with:  npx tsx apps/api/src/queue/demo.ts
 * Or watch the same thing in a browser at http://localhost:15672
 */
import { setupTopology } from "./topology";

process.loadEnvFile();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { connection, channel } = await setupTopology();

  // checkQueue asks the broker directly over AMQP — accurate and instant,
  // unlike the management HTTP API which serves sampled statistics.
  const show = async (label: string) => {
    const work = await channel.checkQueue("fetch.source");
    const dead = await channel.checkQueue("fetch.source.dlq");
    console.log(
      `${label.padEnd(34)} fetch.source=${work.messageCount}   fetch.source.dlq=${dead.messageCount}`,
    );
  };

  await channel.purgeQueue("fetch.source");
  await channel.purgeQueue("fetch.source.dlq");
  await show("start — empty");

  // ---- 1. PUBLISH three messages -------------------------------------
  for (const id of ["job-a", "job-b", "job-c"]) {
    channel.publish("jobs", "fetch.source", Buffer.from(JSON.stringify({ id })), {
      persistent: true,
    });
  }
  await channel.waitForConfirms();
  await show("published 3");

  // ---- 2. CONSUME one, hold it without acking -------------------------
  const first = await channel.get("fetch.source");
  if (!first) throw new Error("expected a message");
  console.log(`\n  picked up: ${first.content.toString()}`);
  await show("holding it (now Unacked, not Ready)");

  // ---- 3. ACK it — the work succeeded ---------------------------------
  channel.ack(first);
  await wait(100);
  await show("acked — gone for good");

  // ---- 4. NACK one with requeue:false — permanent failure -------------
  const second = await channel.get("fetch.source");
  if (!second) throw new Error("expected a message");
  console.log(`\n  picked up: ${second.content.toString()}  -> nack(requeue:false)`);
  channel.nack(second, false, false); // (message, allUpTo, requeue)
  await wait(300);
  await show("dead-lettered");

  // ---- 5. NACK one with requeue:true — temporary failure ---------------
  const third = await channel.get("fetch.source");
  if (!third) throw new Error("expected a message");
  console.log(`\n  picked up: ${third.content.toString()}  -> nack(requeue:true)`);
  channel.nack(third, false, true);
  await wait(300);
  await show("requeued — back on the rail");

  console.log("\n  Leaving one message on fetch.source and one in the DLQ.");
  await channel.close();
  await connection.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
