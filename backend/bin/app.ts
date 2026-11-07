import * as cdk from 'aws-cdk-lib';
import { LogbookStack } from '../lib/logbook-stack.js';

const app = new cdk.App();
const stage: string = app.node.tryGetContext('stage') ?? 'dev';
const region: string = app.node.tryGetContext('region') ?? 'af-south-1';
const allowedOrigins: string[] = app.node.tryGetContext('allowedOrigins') ?? ['*'];
const sesFromEmail: string | undefined = app.node.tryGetContext('sesFromEmail');
const sesRegion: string | undefined = app.node.tryGetContext('sesRegion');

new LogbookStack(app, `ClinicalLogbook-${stage}`, {
  stage,
  allowedOrigins,
  ...(sesFromEmail && { ses: { fromEmail: sesFromEmail, region: sesRegion } }),
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  description: 'Clinical skills logbook: Cognito, HTTP API, Lambda and DynamoDB',
  tags: { project: 'clinical-skills-logbook', stage },
});
