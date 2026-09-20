import { defaultAnalysisSettings } from '@websentry/shared';
import { createAnalyzers } from './dist/analysis/analyzers/index.js';
import { rehydratePage } from './dist/analysis/page-fetcher.service.js';
import { applyPageRules } from './dist/analysis/page-rules.js';

const nav = Array.from({ length: 40 }, (_, i) => `<a href="/rubrique-${i}">Rubrique ${i}</a>`).join('');
const footer = Array.from({ length: 25 }, (_, i) => `<a href="/pied-${i}">Lien pied ${i}</a>`).join('');
const body = Array.from({ length: 120 }, (_, i) =>
  `<section><h2>Titre ${i}</h2><p>Un paragraphe de contenu assez long pour peser dans l'analyse, répété ${i}. <a href="/article-${i}">lire la suite</a> <strong>important</strong></p><img src="/img-${i}.webp" alt="Illustration ${i}"></section>`,
).join('');
const html = `<html lang="fr"><head><title>T</title></head><body><header><nav>${nav}</nav></header><main><h1>Titre</h1>${body}</main><footer>${footer}</footer></body></html>`;
const serialized = { url:'https://exemple.fr/', html, title:'T', platform:'generic', headers:{}, statusCode:200, ttfb:1, redirectChain:[] };
const settings = applyPageRules(serialized.url, defaultAnalysisSettings());
const cible = process.argv[2];
const analyzer = createAnalyzers().find(a => a.id === cible);
for (let i = 0; i < 60; i += 1) {
  const page = rehydratePage(serialized);
  await analyzer.analyze(page, settings, undefined);
}
