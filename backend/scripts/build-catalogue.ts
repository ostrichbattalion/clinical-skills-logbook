/**
 * Builds src/catalogue.json from data/hpcsa_2021_annexure_a.csv
 * (HPCSA PBEC letter "Clinical Skill Requirements", 14 March 2021, Annexure A).
 * Run after editing the CSV:  npm run catalogue
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCsv } from './csv.js';
import { PATIENTS_SEEN_ID, slugify, type CatalogueSkill } from '../src/catalogue-types.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');


const [header, ...rows] = parseCsv(readFileSync(join(root, 'data/hpcsa_2021_annexure_a.csv'), 'utf8'));
if (header[0] !== 'skill' || header.length < 4) throw new Error(`Unexpected CSV header: ${header.join(',')}`);

const seen = new Set<string>();
const skills: CatalogueSkill[] = rows.map(([name, ecp, paramedic, eca], order) => {
  const isPatients = /^total number of patients seen$/i.test(name.trim());
  const id = isPatients ? PATIENTS_SEEN_ID : slugify(name);
  if (seen.has(id)) throw new Error(`Duplicate skill id ${id} (${name})`);
  seen.add(id);
  const num = (v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`Bad minimum "${v}" for ${name}`);
    return n;
  };
  return {
    id,
    name: name.trim(),
    order,
    paediatric: /paediatric|apgar|neonate|child\/infant|umbilical|scalp|incubator/i.test(name),
    derived: isPatients,
    minimums: { ECP: num(ecp), PARAMEDIC: num(paramedic), ECA: num(eca) },
  };
});

const out = {
  source: 'HPCSA Professional Board for Emergency Care, Clinical Skill Requirements letter, 14 March 2021, Annexure A',
  version: 'HPCSA-PBEC-2021-03',
  skills,
};
writeFileSync(join(root, 'src/catalogue.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${skills.length} skills to src/catalogue.json`);
