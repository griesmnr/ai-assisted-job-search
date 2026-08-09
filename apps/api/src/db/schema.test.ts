import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { eq } from "drizzle-orm";
import { jobs, sourceDescriptors } from "./schema";

// Node 22 can read .env itself — no dotenv dependency needed.
process.loadEnvFile();

const client = new Client({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

const db = drizzle(client);

beforeAll(async () => {
  await client.connect();
  await db.insert(sourceDescriptors).values({
    id: "great-source-for-jobs",
    displayName: "Great Source OMG!",
  });
});

describe("jobs table", () => {
  it("rejects a duplicate (data_source, external_id)", async () => {
    await db.insert(jobs).values({
      id: "job1",
      description: "here is the job description",
      externalId: "1234",
      dataSource: "great-source-for-jobs",
      title: "job title",
      company: "the best one",
      payType: "salary",
      commitment: "full-time",
      linkToApply: "www.awesome.com/job1",
      locationType: "hybrid",
      postedAt: new Date(),
    });

    const error = await db
      .insert(jobs)
      .values({
        id: "job2",
        description: "here is the job description",
        externalId: "1234",
        dataSource: "great-source-for-jobs",
        title: "job title",
        company: "the best one",
        payType: "salary",
        commitment: "full-time",
        linkToApply: "www.awesome.com/job1",
        locationType: "hybrid",
        postedAt: new Date(),
      })
      .catch((e) => e);

    expect(error.cause.code).toBe("23505");
  });
});

afterAll(async () => {
  await db.delete(jobs).where(eq(jobs.id, "job1"));
  await db.delete(sourceDescriptors).where(eq(sourceDescriptors.id, "great-source-for-jobs"));
  await client.end();
});
