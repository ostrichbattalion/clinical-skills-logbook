import catalogueJson from './catalogue.json';
import { type CatalogueSkill } from './catalogue-types.js';

export * from './catalogue-types.js';

export const catalogue = catalogueJson as { source: string; version: string; skills: CatalogueSkill[] };
const byId = new Map(catalogue.skills.map((s) => [s.id, s]));

export function getSkill(id: string): CatalogueSkill | undefined {
  return byId.get(id);
}
