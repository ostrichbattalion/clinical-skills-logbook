/**
 * Builds src/requirement-sets.json from data/requirement-sets/<id>.json (institution + programmes) and
 * <id>.csv (one row per college skill, mapped to an HPCSA Annexure A skill, with a minimum per programme year).
 * Run after editing either file:  npm run requirements
 *
 * CSV minimum cells: a number = minimum that year; 0 = offered with no minimum; blank = not in that year's list.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from './csv.js';
import { backendRoot } from './outputs.js';
import { catalogue } from '../src/catalogue.js';
import { CATEGORIES } from '../src/catalogue-types.js';
import type { RequirementSet } from '../src/requirements-types.js';

const dir = join(backendRoot, 'data/requirement-sets');
const hpcsaIds = new Set(catalogue.skills.map((s) => s.id));
const sets: RequirementSet[] = [];

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const meta = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const fail = (msg: string): never => { throw new Error(`${file}: ${msg}`); };
  if (!/^[a-z0-9-]+$/.test(meta.id)) fail('id must be lowercase letters, digits and dashes');
  for (const p of meta.programmes) {
    if (!(CATEGORIES as readonly string[]).includes(p.category)) fail(`programme ${p.id} has bad category ${p.category}`);
    if (!Number.isInteger(p.years) || p.years < 1 || p.years > 6) fail(`programme ${p.id} has bad years`);
  }
  const [header, ...rows] = parseCsv(readFileSync(join(dir, `${meta.id}.csv`), 'utf8'));
  const col = (name: string) => { const i = header.indexOf(name); if (i < 0) fail(`CSV is missing column ${name}`); return i; };
  const c = { id: col('skill_id'), name: col('skill'), group: col('group'), hpcsa: col('hpcsa_skill_id'), specific: col('college_specific'), record: col('record_only'), note: col('mapping_note') };
  const yearCols = meta.programmes.flatMap((p: any) => Array.from({ length: p.years }, (_, i) => ({ programme: p.id, year: i + 1, index: col(`${p.column}_Y${i + 1}`) })));

  const ids = new Set<string>();
  const skills = rows.map((r) => {
    const id = r[c.id].trim();
    if (!/^[a-z0-9-]+$/.test(id) || ids.has(id)) fail(`bad or duplicate skill_id "${id}"`);
    ids.add(id);
    const hpcsaSkillId = r[c.hpcsa].trim() || null;
    if (hpcsaSkillId && !hpcsaIds.has(hpcsaSkillId)) fail(`${id} maps to unknown HPCSA skill ${hpcsaSkillId}`);
    const minimums: Record<string, (number | null)[]> = {};
    for (const yc of yearCols) {
      const v = r[yc.index].trim();
      const n = v === '' ? null : Number(v);
      if (n !== null && (!Number.isInteger(n) || n < 0)) fail(`${id} has bad minimum "${v}"`);
      (minimums[yc.programme] ??= []).push(n);
    }
    return {
      id: `${meta.id}/${id}`,
      name: r[c.name].trim(),
      group: r[c.group].trim(),
      hpcsaSkillId,
      collegeSpecific: r[c.specific].trim() === 'Y',
      recordOnly: r[c.record].trim() === 'Y',
      derived: hpcsaSkillId === 'patients-seen',
      ...(r[c.note].trim() && { note: r[c.note].trim() }),
      minimums,
    };
  });
  sets.push({ id: meta.id, institution: meta.institution, name: meta.name, source: meta.source,
    programmes: meta.programmes.map(({ column: _c, ...p }: any) => p), skills });
  console.log(`${meta.id}: ${skills.length} skills, ${meta.programmes.length} programmes`);
}
writeFileSync(join(backendRoot, 'src/requirement-sets.json'), JSON.stringify({ sets }, null, 1) + '\n');
