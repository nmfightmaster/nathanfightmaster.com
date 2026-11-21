// Retention: visitor log data is deleted after 90 days.
//   - Visit rows live in partitions named by UTC day (`YYYY-MM-DD`). Whole days older than the
//     cutoff are deleted.
//   - Alert claim rows (`alerts-YYYY-MM-DD`, see api/src/lib/alert.js) are only read on the day
//     they're written: the dedupe window is 30 minutes and the cap is per hour, both inside
//     that day's partition. So every claim partition before today is deleted, well inside 90
//     days. They hold a 16-hex-char prefix of the visitor hash, so keeping them longer would
//     serve no purpose.

import { odata } from "@azure/data-tables";
import { utcDay } from "./summary.js";

export const RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;
const BATCH = 100; // the Table service's transaction limit

/** Partition ranges to delete, as OData filters. Both bounds are explicit, so no other partition can match. */
export function retentionFilters(now, days = RETENTION_DAYS) {
  const cutoffDay = utcDay(new Date(now.getTime() - days * DAY_MS));
  const today = utcDay(now);
  return {
    cutoffDay,
    visits: odata`PartitionKey ge ${"2000-01-01"} and PartitionKey lt ${cutoffDay}`,
    claims: odata`PartitionKey ge ${"alerts-"} and PartitionKey lt ${`alerts-${today}`}`,
  };
}

async function keysMatching(table, filter) {
  const byPartition = new Map();
  const entities = table.listEntities({ queryOptions: { filter, select: ["PartitionKey", "RowKey"] } });
  for await (const e of entities) {
    if (!byPartition.has(e.partitionKey)) byPartition.set(e.partitionKey, []);
    byPartition.get(e.partitionKey).push(e.rowKey);
  }
  return byPartition;
}

/** Deletes every row matching `filter`, in per-partition transactions. Returns the row count. */
async function deleteMatching(table, filter, dryRun) {
  // Collect keys first, so deletes never run while a query is paging over the same rows.
  const byPartition = await keysMatching(table, filter);
  let count = 0;
  for (const [partitionKey, rowKeys] of byPartition) {
    for (let i = 0; i < rowKeys.length; i += BATCH) {
      const chunk = rowKeys.slice(i, i + BATCH);
      if (!dryRun) {
        await table.submitTransaction(chunk.map((rowKey) => ["delete", { partitionKey, rowKey }]));
      }
      count += chunk.length;
    }
  }
  return count;
}

/** Deletes expired visit rows and old claim rows. With dryRun, only counts them. */
export async function runRetention(table, now, { dryRun = false } = {}) {
  const f = retentionFilters(now);
  const visits = await deleteMatching(table, f.visits, dryRun);
  const claims = await deleteMatching(table, f.claims, dryRun);
  return { cutoffDay: f.cutoffDay, visits, claims, dryRun };
}
