import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Entry } from './domain.js';

/**
 * Single-table layout
 *   Entry:  PK = STUDENT#<studentSub>  SK = ENTRY#<entryId>
 *   GSI1 (verification queue, only while AWAITING_SIGNATURE):
 *           GSI1PK = VERIFIER#<verifierSub>  GSI1SK = <requestedAt>#<entryId>
 */
export const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const table = () => {
  const t = process.env.TABLE_NAME;
  if (!t) throw new Error('TABLE_NAME is not set');
  return t;
};

type Item = Entry & { PK: string; SK: string; GSI1PK?: string; GSI1SK?: string; entityType: 'Entry' };

export function toItem(e: Entry): Item {
  const item: Item = { ...e, PK: `STUDENT#${e.studentSub}`, SK: `ENTRY#${e.entryId}`, entityType: 'Entry' };
  if (e.status === 'AWAITING_SIGNATURE' && e.request) {
    item.GSI1PK = `VERIFIER#${e.request.verifierSub}`;
    item.GSI1SK = `${e.request.requestedAt}#${e.entryId}`;
  }
  return item;
}

export function fromItem(item: Record<string, unknown>): Entry {
  const { PK: _pk, SK: _sk, GSI1PK: _g1, GSI1SK: _g2, entityType: _t, ...entry } = item;
  return entry as unknown as Entry;
}

export async function createEntry(e: Entry) {
  await doc.send(new PutCommand({ TableName: table(), Item: toItem(e), ConditionExpression: 'attribute_not_exists(PK)' }));
}

export async function getEntry(studentSub: string, entryId: string): Promise<Entry | undefined> {
  const r = await doc.send(new GetCommand({ TableName: table(), Key: { PK: `STUDENT#${studentSub}`, SK: `ENTRY#${entryId}` }, ConsistentRead: true }));
  return r.Item ? fromItem(r.Item) : undefined;
}

async function queryAll(input: ConstructorParameters<typeof QueryCommand>[0]): Promise<Entry[]> {
  const out: Entry[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(new QueryCommand({ ...input, ExclusiveStartKey }));
    out.push(...(r.Items ?? []).map(fromItem));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

export function listEntries(studentSub: string): Promise<Entry[]> {
  return queryAll({
    TableName: table(),
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `STUDENT#${studentSub}`, ':sk': 'ENTRY#' },
    ScanIndexForward: false,
  });
}

export function listQueue(verifierSub: string): Promise<Entry[]> {
  return queryAll({
    TableName: table(),
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `VERIFIER#${verifierSub}` },
  });
}

/**
 * Writes new versions of entries atomically. Each write only succeeds if the stored entry still has the
 * status and updatedAt we read, so two people acting on the same entry cannot both win.
 */
export async function replaceEntries(changes: { before: Entry; after: Entry }[]) {
  await doc.send(
    new TransactWriteCommand({
      TransactItems: changes.map(({ before, after }) => ({
        Put: {
          TableName: table(),
          Item: toItem(after),
          ConditionExpression: '#status = :status AND updatedAt = :updatedAt',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':status': before.status, ':updatedAt': before.updatedAt },
        },
      })),
    }),
  );
}

export async function deleteDraft(studentSub: string, entryId: string) {
  await doc.send(
    new DeleteCommand({
      TableName: table(),
      Key: { PK: `STUDENT#${studentSub}`, SK: `ENTRY#${entryId}` },
      ConditionExpression: '#status IN (:draft, :returned)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':draft': 'DRAFT', ':returned': 'RETURNED' },
    }),
  );
}
