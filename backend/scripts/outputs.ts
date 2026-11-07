import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const backendRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface StackOutputs { Region: string; ApiUrl: string; UserPoolId: string; UserPoolClientId: string; TableName: string }

/** Reads cdk-outputs.json written by `npm run deploy`. Pass the stage if you deployed more than one. */
export function readOutputs(stage?: string): StackOutputs {
  const file = join(backendRoot, 'cdk-outputs.json');
  if (!existsSync(file)) throw new Error('cdk-outputs.json not found: run `npm run deploy` first');
  const all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, StackOutputs>;
  const names = Object.keys(all).filter((k) => k.startsWith('ClinicalLogbook-'));
  const name = stage ? `ClinicalLogbook-${stage}` : names.length === 1 ? names[0] : undefined;
  if (!name || !all[name]) throw new Error(`Pick a stage with --stage (found: ${names.join(', ') || 'none'})`);
  return all[name];
}
