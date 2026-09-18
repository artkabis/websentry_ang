import { describe, expect, it } from 'vitest';
import { DETECT_SCAN_BYTES, detectPlatformAndTitle } from './page-detect.js';

describe('detectPlatformAndTitle', () => {
  it('reconnaît Duda par son conteneur racine', () => {
    const { platform } = detectPlatformAndTitle(
      '<html><body><div id="dmRoot"></div></body></html>',
    );
    expect(platform).toBe('duda');
  });

  it('reconnaît Duda par son CDN, où qu’il apparaisse', () => {
    // Le marqueur peut vivre en fin de document, dans un script : la recherche
    // porte donc sur le HTML entier, pas sur le seul préfixe parsé.
    const tail = `<html><head><title>x</title></head><body>${'<p>a</p>'.repeat(5000)}<img src="https://cdn-website.com/a.png"></body></html>`;
    expect(detectPlatformAndTitle(tail).platform).toBe('duda');
  });

  it('reconnaît WordPress par ses chemins', () => {
    const html = '<html><body><link href="/wp-content/themes/x.css"></body></html>';
    expect(detectPlatformAndTitle(html).platform).toBe('wordpress');
  });

  it('reconnaît WordPress par la classe du body', () => {
    const html = '<html><body class="wordpress"></body></html>';
    expect(detectPlatformAndTitle(html).platform).toBe('wordpress');
  });

  it('retombe sur « generic » sans marqueur', () => {
    expect(detectPlatformAndTitle('<html><body><p>x</p></body></html>').platform).toBe('generic');
  });

  it('PRIORISE Duda sur WordPress quand les deux marqueurs coexistent', () => {
    // Un site Duda peut servir une ressource depuis un ancien WordPress : c'est
    // la plateforme d'hébergement qui compte pour l'analyse.
    const html = '<html><body><div id="dm"></div><link href="/wp-content/x.css"></body></html>';
    expect(detectPlatformAndTitle(html).platform).toBe('duda');
  });

  it('extrait le titre', () => {
    const html = '<html><head><title>  Accueil  </title></head></html>';
    expect(detectPlatformAndTitle(html).title).toBe('Accueil');
  });

  it('retombe sur og:title quand <title> manque', () => {
    const html = '<html><head><meta property="og:title" content="Secours"></head></html>';
    expect(detectPlatformAndTitle(html).title).toBe('Secours');
  });

  it('rend une chaîne vide quand aucun titre n’existe', () => {
    expect(detectPlatformAndTitle('<html><body></body></html>').title).toBe('');
  });

  it('ne parse que le PRÉFIXE pour le titre', () => {
    // Parser des centaines de kilo-octets pour lire un <title> bloquerait la
    // boucle d'événements du thread principal.
    const filler = '<p>a</p>'.repeat(DETECT_SCAN_BYTES);
    const html = `<html><body>${filler}<title>Trop loin</title></body></html>`;
    expect(detectPlatformAndTitle(html).title).toBe('');
  });
});
