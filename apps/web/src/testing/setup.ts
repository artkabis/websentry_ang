import '@analogjs/vite-plugin-angular/setup-vitest';
import { getTestBed } from '@angular/core/testing';
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from '@angular/platform-browser/testing';

/**
 * Initialisation unique du banc de test Angular.
 *
 * Sans cet appel, chaque `TestBed.configureTestingModule` lèverait faute de
 * plateforme initialisée.
 */
getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
