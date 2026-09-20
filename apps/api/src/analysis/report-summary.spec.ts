import { describe, expect, it } from 'vitest';
import type { CheckResult } from '@websentry/shared';
import { toCheckSummary } from './report-summary.js';

const check = (checkId: string, status: CheckResult['status']): CheckResult => ({
  checkId,
  checkTitle: checkId,
  globalScore: 5,
  status,
  items: [{ label: 'x', status }],
  summary: 'résumé très long qui ne doit pas se retrouver dans le résumé compact',
  recommendations: ['une recommandation'],
});

describe('toCheckSummary', () => {
  it('réduit chaque critère à son STATUT', () => {
    const summary = toCheckSummary({
      METAS: check('METAS', 'pass'),
      HN_STRUCTURE: check('HN_STRUCTURE', 'fail'),
    });
    expect(summary).toEqual({ METAS: 'pass', HN_STRUCTURE: 'fail' });
  });

  it('n’emporte NI items NI recommandations', () => {
    // Ce résumé survit à la purge du rapport : il doit rester minuscule, sans
    // quoi la rétention n'économise plus rien.
    const serialized = JSON.stringify(toCheckSummary({ METAS: check('METAS', 'warning') }));
    expect(serialized).not.toContain('recommandation');
    expect(serialized).not.toContain('résumé très long');
  });

  it('rend un objet vide pour un rapport sans critère', () => {
    expect(toCheckSummary({})).toEqual({});
  });
});
