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
import type { SignRequest } from './sign-requests.js';

/**
 * Single-table layout
 *   Entry:  PK = STUDENT#<studentSub>  SK = ENTRY#<entryId>
 *   GSI1 (verification queue, only while AWAITING_SIGNATURE):
 *           GSI1PK = VERIFIER#<verifierSub>  GSI1SK = <requestedAt>#<entryId>
 *   GSI2 (institution reports, every entry):
 *           GSI2PK = INST#<institution>      GSI2SK = <studentSub>#<entryId>
 */
export const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const table = () => {
  const t = process.env.TABLE_NAME;
  if (!t) throw new Error('TABLE_NAME is not set');
  return t;
};

type Item = Entry & { PK: string; SK: string; GSI1PK?: string; GSI1SK?: string; GSI2PK: string; GSI2SK: string; entityType: 'Entry' };

export function toItem(e: Entry): Item {
  const item: Item = {
    ...e, PK: `STUDENT#${e.studentSub}`, SK: `ENTRY#${e.entryId}`, entityType: 'Entry',
    GSI2PK: `INST#${e.institution}`, GSI2SK: `${e.studentSub}#${e.entryId}`,
  };
  if (e.status === 'AWAITING_SIGNATURE' && e.request) {
    item.GSI1PK = `VERIFIER#${e.request.verifierSub}`;
    item.GSI1SK = `${e.request.requestedAt}#${e.entryId}`;
  }
  return item;
}

export function fromItem(item: Record<string, unknown>): Entry {
  const { PK: _pk, SK: _sk, GSI1PK: _g1, GSI1SK: _g2, GSI2PK: _g3, GSI2SK: _g4, entityType: _t, ...entry } = item;
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

/** Every entry at an institution, for cohort reports. */
export function listInstitutionEntries(institution: string): Promise<Entry[]> {
  return queryAll({
    TableName: table(),
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': `INST#${institution}` },
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

export interface AuditEvent {
  institution: string;
  at: string;
  actorSub: string;
  actorName: string;
  action: string;
  targetEmail?: string;
  details?: string;
}

/** Records an admin action. Audit items: PK = AUDIT#<institution>, SK = <timestamp>#<random>. */
export async function putAudit(e: AuditEvent) {
  await doc.send(new PutCommand({
    TableName: table(),
    Item: { PK: `AUDIT#${e.institution}`, SK: `${e.at}#${Math.random().toString(36).slice(2, 10)}`, entityType: 'Audit', ...e },
  }));
}

export async function listAudit(institution: string, limit = 50): Promise<AuditEvent[]> {
  const r = await doc.send(new QueryCommand({
    TableName: table(),
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `AUDIT#${institution}` },
    ScanIndexForward: false,
    Limit: limit,
  }));
  return (r.Items ?? []).map(({ PK: _p, SK: _s, entityType: _t, ...rest }) => rest as AuditEvent);
}


/** Sign requests: PK = SIGNREQ#<sha256 of code>, SK = SIGNREQ; `ttl` lets DynamoDB delete them a day after expiry. */
export async function putSignRequest(r: SignRequest) {
  await doc.send(new PutCommand({
    TableName: table(),
    Item: { PK: `SIGNREQ#${r.tokenHash}`, SK: 'SIGNREQ', entityType: 'SignRequest', ttl: Math.floor(Date.parse(r.expiresAt) / 1000) + 86400, ...r },
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
}

export async function getSignRequest(tokenHash: string): Promise<SignRequest | undefined> {
  const r = await doc.send(new GetCommand({ TableName: table(), Key: { PK: `SIGNREQ#${tokenHash}`, SK: 'SIGNREQ' }, ConsistentRead: true }));
  if (!r.Item) return undefined;
  const { PK: _p, SK: _s, entityType: _t, ttl: _ttl, ...rest } = r.Item;
  return rest as SignRequest;
}

/** Marks the request claimed and assigns its entries in one transaction: it fails if anyone got there first. */
export async function claimSignRequest(claimed: SignRequest, changes: { before: Entry; after: Entry }[]) {
  await doc.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: table(),
          Item: { PK: `SIGNREQ#${claimed.tokenHash}`, SK: 'SIGNREQ', entityType: 'SignRequest', ttl: Math.floor(Date.parse(claimed.expiresAt) / 1000) + 86400, ...claimed },
          ConditionExpression: '#status = :open AND expiresAt > :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':open': 'OPEN', ':now': claimed.claimedBy!.at },
        },
      },
      ...changes.map(({ before, after }) => ({
        Put: {
          TableName: table(),
          Item: toItem(after),
          ConditionExpression: '#status = :status AND updatedAt = :updatedAt',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':status': before.status, ':updatedAt': before.updatedAt },
        },
      })),
    ],
  }));
}
