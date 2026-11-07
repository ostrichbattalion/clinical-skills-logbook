export const CATEGORIES = ['ECA', 'PARAMEDIC', 'ECP'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Annexure A row "Total number of patients seen" — derived from signed encounters, never logged directly. */
export const PATIENTS_SEEN_ID = 'patients-seen';

export interface CatalogueSkill {
  id: string;
  name: string;
  order: number;
  paediatric: boolean;
  /** true for rows the system computes rather than the student logging them */
  derived: boolean;
  minimums: Record<Category, number>;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
