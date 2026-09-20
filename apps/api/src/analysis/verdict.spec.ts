import { describe, expect, it } from 'vitest';
import type { CheckItem } from '@websentry/shared';
import { FAIL_SCORE, PASS_SCORE, WARN_SCORE, gradedVerdict, verdictOf } from './verdict.js';

const item = (status: CheckItem['status']): CheckItem => ({ label: 'x', status });

describe('verdictOf', () => {
  it('un échec l’emporte sur tout le reste', () => {
    const verdict = verdictOf([item('pass'), item('warning'), item('fail')]);
    expect(verdict).toMatchObject({ status: 'fail', globalScore: FAIL_SCORE });
  });

  it('un avertissement l’emporte sur les réussites', () => {
    expect(verdictOf([item('pass'), item('warning')])).toMatchObject({
      status: 'warning',
      globalScore: WARN_SCORE,
    });
  });

  it('n’est conforme que sans défaut', () => {
    expect(verdictOf([item('pass'), item('info')])).toMatchObject({
      status: 'pass',
      globalScore: PASS_SCORE,
    });
  });

  it('IGNORE les items informatifs dans le décompte', () => {
    // Un item `info` documente sans juger : le compter comme défaut rendrait
    // le critère impossible à réussir.
    expect(verdictOf([item('info'), item('na')]).status).toBe('pass');
  });

  it('est conforme sur une liste vide', () => {
    expect(verdictOf([]).status).toBe('pass');
  });

  it('remonte le décompte des défauts', () => {
    expect(verdictOf([item('fail'), item('fail'), item('warning')])).toMatchObject({
      failures: 2,
      warnings: 1,
    });
  });
});

describe('gradedVerdict', () => {
  it('DÉGRADE la note à mesure que les échecs s’accumulent', () => {
    // Trois images sans alt sont plus graves qu'une seule, là où une canonical
    // absente est un fait binaire.
    expect(gradedVerdict([item('fail')]).globalScore).toBe(2);
    expect(gradedVerdict([item('fail'), item('fail')]).globalScore).toBe(1);
    expect(gradedVerdict([item('fail'), item('fail'), item('fail')]).globalScore).toBe(0);
  });

  it('ne descend jamais sous zéro', () => {
    const many = Array.from({ length: 10 }, () => item('fail'));
    expect(gradedVerdict(many).globalScore).toBe(0);
  });

  it('plafonne la pénalité des avertissements à 2', () => {
    const many = Array.from({ length: 10 }, () => item('warning'));
    expect(gradedVerdict(many).globalScore).toBe(2);
  });

  it('reste à 5 sans défaut', () => {
    expect(gradedVerdict([item('pass')]).globalScore).toBe(PASS_SCORE);
  });
});
